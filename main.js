import * as pdfjsLib from "./lib/pdfjs/build/pdf.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "./lib/pdfjs/build/pdf.worker.mjs";
const VIEWER_URL = "./lib/pdfjs/web/viewer.html";

const EPSILON = 0.0001;
const CHUNK_SIZE = 800;

class SrtUtils {
  static parse(rawText) {
    const entries = [];
    const blocks = rawText
      .replace(/\r\n/g, "\n")
      .trim()
      .split(/\n\s*\n/);

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 2) continue;

      const indexLine = lines[0].trim();
      const timeLine = lines[1].trim();

      const timeMatch = timeLine.match(
        /(\d{2}:\d{2}:\d{2}[,.:]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.:]\d{3})/,
      );
      if (!timeMatch) continue;

      const startTime = timeMatch[1].replace(",", ".");
      const endTime = timeMatch[2].replace(",", ".");
      const text = lines
        .slice(2)
        .join(" ")
        .replace(/<[^>]+>/g, "")
        .trim();

      if (!text) continue;

      entries.push({
        index: parseInt(indexLine, 10) || entries.length + 1,
        startTime,
        endTime,
        text,
      });
    }

    return entries;
  }

  static formatTimestamp(ts) {
    const [hms] = ts.split(".");
    const [h, m, s] = hms.split(":");
    return h === "00" ? `${m}:${s}` : `${parseInt(h, 10)}:${m}:${s}`;
  }

  static escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

class DocumentStore {
  constructor() {
    this.nextId = 0;
    this.meta = new Map(); // documentId -> { type, name, content?/entries? }
    this.pdfBuffers = new Map(); // documentId -> ArrayBuffer
    this.chunks = []; // flat list across all documents
    this.embeddings = []; // parallel to this.chunks
  }

  allocateId() {
    return this.nextId++;
  }

  setMeta(documentId, meta) {
    this.meta.set(documentId, meta);
  }

  getMeta(documentId) {
    return this.meta.get(documentId);
  }

  setBuffer(documentId, buffer) {
    this.pdfBuffers.set(documentId, buffer);
  }

  getBuffer(documentId) {
    return this.pdfBuffers.get(documentId);
  }

  addChunks(newChunks) {
    this.chunks.push(...newChunks);
  }

  addEmbeddings(newEmbeddings) {
    this.embeddings.push(...newEmbeddings);
  }

  chunkCountForDocument(documentId) {
    return this.chunks.filter((c) => c.documentId === documentId).length;
  }

  reset() {
    this.nextId = 0;
    this.meta.clear();
    this.pdfBuffers.clear();
    this.chunks = [];
    this.embeddings = [];
  }
}

class TxtReader {
  static matches(file) {
    return (
      file.type === "text/plain" || file.name.toLowerCase().endsWith(".txt")
    );
  }

  async read(file, documentId, store) {
    const text = await file.text();
    store.setMeta(documentId, { type: "txt", name: file.name, content: text });

    const PAGE_SIZE = 3000;
    const pages = [];
    for (let i = 0; i < text.length; i += PAGE_SIZE) {
      pages.push({
        documentId,
        pageNumber: pages.length + 1,
        documentTitle: file.name,
        content: text.slice(i, i + PAGE_SIZE),
      });
    }
    if (pages.length === 0) {
      pages.push({
        documentId,
        pageNumber: 1,
        documentTitle: file.name,
        content: "",
      });
    }
    return pages;
  }
}

class SrtReader {
  static matches(file) {
    const nameLower = file.name.toLowerCase();
    return (
      file.type === "application/x-subrip" ||
      file.type === "text/x-srt" ||
      nameLower.endsWith(".srt")
    );
  }

  async read(file, documentId, store) {
    const text = await file.text();
    const entries = SrtUtils.parse(text);

    store.setMeta(documentId, { type: "srt", name: file.name, entries });

    const pages = entries.map((entry) => ({
      documentId,
      pageNumber: entry.index,
      documentTitle: file.name,
      content: entry.text,
      startTime: entry.startTime,
    }));

    if (pages.length === 0) {
      pages.push({
        documentId,
        pageNumber: 1,
        documentTitle: file.name,
        content: "",
        startTime: null,
      });
    }

    return pages;
  }
}

class PdfReader {
  static matches() {
    return true; // fallback reader
  }

  async read(file, documentId, store) {
    const arrayBuffer = await file.arrayBuffer();
    store.setBuffer(documentId, arrayBuffer.slice(0));

    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
    }).promise;
    const documentTitle = pdf.title || file.name;
    store.setMeta(documentId, { type: "pdf", name: file.name });

    return Promise.all(
      Array.from({ length: pdf.numPages }, async (_, pageIndex) => ({
        documentId,
        pageNumber: pageIndex + 1,
        documentTitle,
        content: await pdf
          .getPage(pageIndex + 1)
          .then((p) => p.getTextContent())
          .then((c) => c.items.map((i) => i.str).join(" ")),
      })),
    );
  }
}

class FileReaderRouter {
  constructor() {
    this.readers = [new SrtReader(), new TxtReader(), new PdfReader()];
  }

  pickReader(file) {
    return this.readers.find((r) => r.constructor.matches(file));
  }

  async readFiles(files, store, onFileDone) {
    return Promise.all(
      files.map(async (file, index) => {
        const documentId = store.allocateId();
        const reader = this.pickReader(file);
        const pages = await reader.read(file, documentId, store);
        onFileDone?.(index, documentId, file, pages);
        return { documentId, file, pages };
      }),
    );
  }
}

class Chunker {
  static chunkDocumentPages(pages) {
    const chunks = [];
    let current = {
      content: "",
      pageNumber: null,
      documentTitle: null,
      documentId: null,
      startTime: null,
    };

    for (const page of pages) {
      const sentences = page.content.match(/[^.]+\.(?= |\n)/g) ?? [
        page.content,
      ];
      for (const sentence of sentences) {
        if (current.content.length + sentence.length > CHUNK_SIZE) {
          if (current.content)
            chunks.push({ ...current, content: current.content.trim() });
          current = {
            documentId: page.documentId,
            documentTitle: page.documentTitle,
            pageNumber: page.pageNumber,
            content: sentence,
            startTime: page.startTime ?? null,
          };
        } else {
          current.content += sentence;
          if (!current.pageNumber) {
            current.pageNumber = page.pageNumber;
            current.documentTitle = page.documentTitle;
            current.documentId = page.documentId;
            current.startTime = page.startTime ?? null;
          }
        }
      }
    }

    if (current.content.trim())
      chunks.push({ ...current, content: current.content.trim() });
    return chunks;
  }
}

class EmbeddingWorkerPool {
  constructor(size) {
    this.size = Math.max(size, 1);
    this.workers = [];
    this.taskQueue = [];
  }

  _createWorker(onTaskComplete) {
    const entry = {
      worker: new Worker("./embedding-worker.js", { type: "module" }),
      busy: false,
    };

    entry.worker.onmessage = ({ data }) => {
      entry.busy = false;
      const resolve = entry.resolve;
      entry.resolve = null;
      onTaskComplete?.(data);
      resolve(data.embedding);
      this._runNext();
    };

    return entry;
  }

  _runNext() {
    if (this.taskQueue.length === 0) return;
    const freeWorker = this.workers.find((w) => !w.busy);
    if (!freeWorker) return;

    const { content, resolve } = this.taskQueue.shift();
    freeWorker.busy = true;
    freeWorker.resolve = resolve;
    freeWorker.worker.postMessage(content);
  }

  async embedChunks(chunks, onTaskComplete) {
    if (chunks.length === 0) return [];

    this.workers = Array.from(
      { length: Math.min(this.size, chunks.length) },
      () => this._createWorker(onTaskComplete),
    );

    const embeddings = await Promise.all(
      chunks.map(
        (chunk) =>
          new Promise((resolve) => {
            this.taskQueue.push({
              content: { content: chunk.content, documentId: chunk.documentId },
              resolve,
            });
            this._runNext();
          }),
      ),
    );

    this.workers.forEach(({ worker }) => worker.terminate());
    this.workers = [];
    return embeddings;
  }

  terminate() {
    this.workers.forEach(({ worker }) => worker.terminate());
    this.workers = [];
  }
}

class QueryEmbedder {
  constructor() {
    this.worker = new Worker("./embedding-worker.js", { type: "module" });
  }

  embed(text) {
    return new Promise((resolve) => {
      const handler = (event) => {
        this.worker.removeEventListener("message", handler);
        resolve(event.data.embedding);
      };
      this.worker.addEventListener("message", handler);
      this.worker.postMessage({ content: text, documentId: -1 });
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

class SearchEngine {
  static cosineSimilarity(a, b) {
    const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dot / (magA * magB);
  }

  static topN(queryEmbedding, chunks, embeddings, n) {
    return embeddings
      .map((embedding, index) => ({
        index,
        distance: 1 - SearchEngine.cosineSimilarity(embedding, queryEmbedding),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, n)
      .map(({ index, distance }) => {
        const chunk = chunks[index];
        return {
          documentId: chunk.documentId,
          documentTitle: chunk.documentTitle,
          pageNumber: chunk.pageNumber,
          content: chunk.content,
          startTime: chunk.startTime ?? null,
          distance,
        };
      });
  }
}

class DocumentViewer {
  constructor(canvasViewerEl, textViewerEl, store) {
    this.canvasViewerEl = canvasViewerEl;
    this.textViewerEl = textViewerEl;
    this.store = store;

    this.viewerFrame = document.createElement("iframe");
    canvasViewerEl.style.padding = "0";
    canvasViewerEl.append(this.viewerFrame);

    this.currentDocumentId = null;
    this.currentBlobUrl = null;
  }

  reset() {
    this.currentDocumentId = null;
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }
    this.viewerFrame.src = "about:blank";
    this.canvasViewerEl.style.display = "block";
    this.textViewerEl.style.display = "none";
    this.textViewerEl.textContent = "";
  }

  async renderPage(documentId, pageNumber, chunkText) {
    const meta = this.store.getMeta(documentId);
    if (!meta) return;

    if (meta.type === "txt")
      return this._renderTxt(documentId, meta, chunkText);
    if (meta.type === "srt")
      return this._renderSrt(documentId, meta, pageNumber);
    return this._renderPdf(documentId, pageNumber, chunkText);
  }

  _renderTxt(documentId, meta, chunkText) {
    this.canvasViewerEl.style.display = "none";
    this.textViewerEl.style.display = "block";

    if (this.currentDocumentId !== documentId) {
      this.currentDocumentId = documentId;
      this.textViewerEl.textContent = meta.content ?? "";
    }

    if (chunkText) {
      const needle = chunkText.trim().slice(0, 120);
      const full = meta.content ?? "";
      const idx = full.indexOf(needle);
      if (idx !== -1) {
        const before = full.slice(0, idx);
        const match = full.slice(idx, idx + chunkText.length);
        const after = full.slice(idx + chunkText.length);
        this.textViewerEl.innerHTML =
          SrtUtils.escapeHtml(before) +
          `<mark>` +
          SrtUtils.escapeHtml(match) +
          `</mark>` +
          SrtUtils.escapeHtml(after);
        this.textViewerEl
          .querySelector("mark")
          ?.scrollIntoView({ behavior: "smooth" });
      } else {
        this.textViewerEl.textContent = full;
      }
    }
  }

  _renderSrt(documentId, meta, pageNumber) {
    this.canvasViewerEl.style.display = "none";
    this.textViewerEl.style.display = "block";
    this.currentDocumentId = documentId;

    const entries = meta.entries;
    this.textViewerEl.innerHTML = entries
      .map((entry) => {
        const escapedText = SrtUtils.escapeHtml(entry.text);
        const ts = `<span class="srt-timestamp">${SrtUtils.formatTimestamp(entry.startTime)}</span>`;
        const span = `<p data-srt-index="${entry.index}">${ts} ${escapedText}</p>`;
        return pageNumber === entry.index ? `<mark>${span}</mark>` : span;
      })
      .join("");

    const target =
      this.textViewerEl.querySelector("mark") ??
      this.textViewerEl.querySelector(`[data-srt-index="${pageNumber}"]`);
    target?.scrollIntoView({
      behavior: "smooth",
      block: "start",
      inline: "nearest",
    });
  }

  _highlightChunk(app, chunkText) {
    if (!chunkText) return;

    const normalized = chunkText
      .replace(/-\s+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const match = normalized.match(/[A-Za-z][^.]{20,}/);
    const query = match
      ? match[0].slice(0, 80).replace(/\s+\S*$/, "")
      : normalized.slice(0, 80).replace(/\s+\S*$/, "");

    app.eventBus.dispatch("find", {
      query,
      type: "",
      caseSensitive: false,
      entireWord: false,
      highlightAll: false,
      findPrevious: false,
    });
  }

  async _renderPdf(documentId, pageNumber, chunkText) {
    const buffer = this.store.getBuffer(documentId);
    if (!buffer) return;

    this.textViewerEl.style.display = "none";
    this.canvasViewerEl.style.display = "block";

    if (this.currentDocumentId !== documentId) {
      this.currentDocumentId = documentId;

      if (this.currentBlobUrl) {
        URL.revokeObjectURL(this.currentBlobUrl);
        this.currentBlobUrl = null;
      }

      const blob = new Blob([buffer], { type: "application/pdf" });
      this.currentBlobUrl = URL.createObjectURL(blob);

      await new Promise((resolve) => {
        this.viewerFrame.addEventListener("load", resolve);
        this.viewerFrame.src = VIEWER_URL + "?file=&sidebarView=0";
      });
      const app = await this.viewerFrame.contentWindow.PDFViewerApplication;
      await app.open({ url: this.currentBlobUrl });

      app.eventBus.on(
        "pagesloaded",
        () => {
          app.pdfSidebar?.close();
          app.pdfViewer.scrollPageIntoView({ pageNumber });
          this._highlightChunk(app, chunkText);
        },
        { once: true },
      );
    } else {
      const app = this.viewerFrame.contentWindow?.PDFViewerApplication;
      if (!app) return;
      app.pdfViewer.scrollPageIntoView({ pageNumber });
      this._highlightChunk(app, chunkText);
    }
  }
}

class InputListUI {
  constructor(listEl) {
    this.listEl = listEl;
  }

  addEntry(documentId, name, chunkCount) {
    const listItem = document.createElement("li");
    const infoDiv = document.createElement("div");
    const titleSpan = document.createElement("span");
    titleSpan.textContent = name;
    const chunkCountSpan = document.createElement("span");
    chunkCountSpan.classList.add("light-text");
    chunkCountSpan.textContent = chunkCount + " chunks";
    const progressBar = document.createElement("progress");
    progressBar.id = "input-progress-" + documentId;
    progressBar.value = 0;
    progressBar.max = 1;
    infoDiv.append(titleSpan, chunkCountSpan);
    listItem.append(infoDiv, progressBar);
    this.listEl.append(listItem);
  }

  bumpProgress(documentId, increment) {
    const bar = document.getElementById("input-progress-" + documentId);
    if (!bar) return;
    bar.value += increment;
    if (bar.value >= 1 - EPSILON) bar.remove();
  }

  clear() {
    this.listEl.innerHTML = "";
  }
}

class OutputListUI {
  constructor(listEl, store, onSelect) {
    this.listEl = listEl;
    this.store = store;
    this.onSelect = onSelect;
  }

  render(closestChunks) {
    this.listEl.innerHTML = "";

    closestChunks.forEach((chunk) => {
      const listItem = document.createElement("li");
      listItem.style.cursor = "pointer";
      listItem.setAttribute("role", "button");

      const infoDiv = document.createElement("div");
      infoDiv.classList.add("output-info");

      const scoreSpan = document.createElement("span");
      scoreSpan.classList.add("light-text");
      scoreSpan.textContent = Math.round((1 - chunk.distance) * 100) + "%";

      const sourceSpan = document.createElement("span");
      sourceSpan.classList.add("light-text");
      sourceSpan.textContent = chunk.documentTitle;

      const pageSpan = document.createElement("span");
      pageSpan.classList.add("light-text");

      const meta = this.store.getMeta(chunk.documentId);
      if (meta?.type === "srt") {
        pageSpan.textContent = chunk.startTime
          ? SrtUtils.formatTimestamp(chunk.startTime)
          : "§" + chunk.pageNumber;
      } else if (meta?.type === "txt") {
        pageSpan.textContent = "§" + chunk.pageNumber;
      } else {
        pageSpan.textContent = "p." + chunk.pageNumber;
      }

      const contentDiv = document.createElement("div");
      contentDiv.textContent = chunk.content;

      infoDiv.append(scoreSpan, sourceSpan, pageSpan);
      listItem.append(infoDiv, contentDiv);

      listItem.addEventListener("click", () => {
        this.listEl
          .querySelectorAll("li")
          .forEach((li) => li.removeAttribute("data-active"));
        listItem.setAttribute("data-active", "true");
        this.onSelect(chunk.documentId, chunk.pageNumber, chunk.content);
      });

      this.listEl.append(listItem);
    });
  }

  clear() {
    this.listEl.innerHTML = "";
  }
}

class PdfQaApp {
  constructor() {
    this.fileInput = document.getElementById("file-input");
    this.progressBar = document.getElementById("progress-bar");
    this.queryText = document.getElementById("query-text");
    this.queryButton = document.getElementById("query-submit");
    this.inputListEl = document.getElementById("input-list");
    this.outputListEl = document.getElementById("output-list");
    this.canvasViewerEl = document.getElementById("canvas-viewer");
    this.textViewerEl = document.getElementById("plain-text-viewer");

    this.store = new DocumentStore();
    this.fileReaderRouter = new FileReaderRouter();
    this.viewer = new DocumentViewer(
      this.canvasViewerEl,
      this.textViewerEl,
      this.store,
    );
    this.inputListUI = new InputListUI(this.inputListEl);
    this.outputListUI = new OutputListUI(
      this.outputListEl,
      this.store,
      (docId, pageNum, text) => this.viewer.renderPage(docId, pageNum, text),
    );
    this.queryEmbedder = new QueryEmbedder();

    this.fileInput.setAttribute(
      "accept",
      ".pdf,.txt,.srt,application/pdf,text/plain,application/x-subrip,text/x-srt",
    );

    this._bindEvents();
  }

  _bindEvents() {
    this.fileInput.addEventListener("input", () => this._handleFilesAdded());
    this.queryButton.addEventListener("click", () => this._handleQuery());
  }

  async _handleFilesAdded() {
    const isFirstBatch =
      this.store.chunks.length === 0 && this.store.meta.size === 0;

    if (isFirstBatch) {
      Array.from(document.getElementsByClassName("hide-on-start")).forEach(
        (element) => {
          element.style.display = "none";
        },
      );
      this.viewer.reset();
    }

    this.progressBar.removeAttribute("value");

    const files = Array.from(this.fileInput.files);
    if (files.length === 0) return;

    // Read files, chunk them, and register new list entries.
    const results = await this.fileReaderRouter.readFiles(
      files,
      this.store,
      () => {
        this.progressBar.value += 1 / files.length;
      },
    );

    const newChunksByFile = results.map(({ pages }) =>
      Chunker.chunkDocumentPages(pages),
    );
    const newChunks = newChunksByFile.flat();

    if (newChunks.length === 0) {
      this.progressBar.removeAttribute("value");
      this.queryButton.disabled = false;
      return;
    }

    this.store.addChunks(newChunks);

    results.forEach(({ documentId, file }) => {
      const chunkCount = this.store.chunkCountForDocument(documentId);
      this.inputListUI.addEntry(documentId, file.name, chunkCount);
    });

    this.progressBar.removeAttribute("value");

    // Embed only the newly added chunks.
    const pool = new EmbeddingWorkerPool(
      Math.max(navigator.hardwareConcurrency, 4),
    );
    const newEmbeddings = await pool.embedChunks(newChunks, (data) => {
      this.progressBar.value += 1 / newChunks.length;
      this.inputListUI.bumpProgress(
        data.documentId,
        1 / this.store.chunkCountForDocument(data.documentId),
      );
    });

    this.store.addEmbeddings(newEmbeddings);
    this.progressBar.value = 0;

    this.queryButton.disabled = false;

    // Allow selecting the same file(s) again later.
    this.fileInput.value = "";
  }

  async _handleQuery() {
    this.queryButton.disabled = true;
    const query = this.queryText.value;
    this.outputListUI.clear();

    const queryEmbedding = await this.queryEmbedder.embed(query);

    const n = 25;
    const closestChunks = SearchEngine.topN(
      queryEmbedding,
      this.store.chunks,
      this.store.embeddings,
      n,
    );

    this.outputListUI.render(closestChunks);

    this.queryButton.disabled = false;
  }
}

new PdfQaApp();
