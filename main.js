import * as pdfjsLib from "./lib/pdfjs/build/pdf.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "./lib/pdfjs/build/pdf.worker.mjs";

const EPSILON = 0.0001;

const PDF_INPUT = document.getElementById("file-input");
const PROGRESS_BAR = document.getElementById("progress-bar");
const QUERY_TEXT = document.getElementById("query-text");
const QUERY_BUTTON = document.getElementById("query-submit");
const INPUT_LIST = document.getElementById("input-list");
const OUTPUT_LIST = document.getElementById("output-list");
const CANVAS_VIEWER = document.getElementById("canvas-viewer");
const TEXT_VIEWER = document.getElementById("plain-text-viewer");

const CHUNK_SIZE = 800;

const pdfBuffers = new Map();

let currentBlobUrl = null;

const viewerFrame = document.createElement("iframe");
CANVAS_VIEWER.style.padding = "0";
CANVAS_VIEWER.append(viewerFrame);

const VIEWER_URL = "./lib/pdfjs/web/viewer.html";

let currentDocumentId = null;
const documentMeta = new Map();

function waitForViewer(win) {
  return new Promise((resolve) => {
    const tryResolve = () => {
      const app = win.PDFViewerApplication;
      if (!app) return false;
      if (app.initialized) {
        resolve(app);
        return true;
      }
      if (app.initializedPromise) {
        app.initializedPromise.then(() => resolve(app));
        return true;
      }
      return false;
    };

    if (!tryResolve()) {
      viewerFrame.addEventListener(
        "load",
        () => {
          const app = win.PDFViewerApplication;
          if (app?.initializedPromise) {
            app.initializedPromise.then(() => resolve(app));
          } else {
            resolve(app);
          }
        },
        { once: true },
      );
    }
  });
}

function parseSrt(rawText) {
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

function formatTimestamp(ts) {
  const [hms] = ts.split(".");
  const [h, m, s] = hms.split(":");
  return h === "00" ? `${m}:${s}` : `${parseInt(h, 10)}:${m}:${s}`;
}

async function renderPage(documentId, pageNumber, chunkText) {
  const meta = documentMeta.get(documentId);
  if (!meta) return;

  if (meta.type === "txt") {
    CANVAS_VIEWER.style.display = "none";
    TEXT_VIEWER.style.display = "block";

    if (currentDocumentId !== documentId) {
      currentDocumentId = documentId;
      TEXT_VIEWER.textContent = meta.content ?? "";
    }

    if (chunkText) {
      const needle = chunkText.trim().slice(0, 120);
      const full = meta.content ?? "";
      const idx = full.indexOf(needle);
      if (idx !== -1) {
        const before = full.slice(0, idx);
        const match = full.slice(idx, idx + chunkText.length);
        const after = full.slice(idx + chunkText.length);
        const esc = (s) =>
          s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        TEXT_VIEWER.innerHTML =
          esc(before) + `<mark>` + esc(match) + `</mark>` + esc(after);
        TEXT_VIEWER.querySelector("mark")?.scrollIntoView({
          behavior: "smooth",
        });
      } else {
        TEXT_VIEWER.textContent = full;
      }
    }
    return;
  }

  if (meta.type === "srt") {
    CANVAS_VIEWER.style.display = "none";
    TEXT_VIEWER.style.display = "block";
    currentDocumentId = documentId;

    const entries = meta.entries;
    const esc = (s) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    TEXT_VIEWER.innerHTML = entries
      .map((entry) => {
        const escapedText = esc(entry.text);
        const ts = `<span class="srt-timestamp">${formatTimestamp(entry.startTime)}</span>`;
        const span = `<p data-srt-index="${entry.index}">${ts} ${escapedText}</p>`;

        return pageNumber === entry.index ? `<mark>${span}</mark>` : span;
      })
      .join("");

    const target =
      TEXT_VIEWER.querySelector("mark") ??
      TEXT_VIEWER.querySelector(`[data-srt-index="${pageNumber}"]`);
    target?.scrollIntoView({
      behavior: "smooth",
      block: "start",
      inline: "nearest",
    });
    return;
  }

  const buffer = pdfBuffers.get(documentId);
  if (!buffer) return;

  TEXT_VIEWER.style.display = "none";
  CANVAS_VIEWER.style.display = "block";

  const highlightChunk = (app) => {
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
  };

  if (currentDocumentId !== documentId) {
    currentDocumentId = documentId;

    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }

    const blob = new Blob([buffer], { type: "application/pdf" });
    currentBlobUrl = URL.createObjectURL(blob);

    await new Promise((resolve) => {
      viewerFrame.onload = resolve;
      viewerFrame.src = VIEWER_URL + "?file=";
    });

    const app = await waitForViewer(viewerFrame.contentWindow);

    await app.open({ url: currentBlobUrl });

    app.eventBus.on(
      "pagesloaded",
      () => {
        app.pdfViewer.scrollPageIntoView({ pageNumber });
        highlightChunk(app);
      },
      { once: true },
    );
  } else {
    const app = viewerFrame.contentWindow?.PDFViewerApplication;
    if (!app) return;
    app.pdfViewer.scrollPageIntoView({ pageNumber });
    highlightChunk(app);
  }
}

async function readTxtFile(file, fileIndex) {
  const text = await file.text();
  documentMeta.set(fileIndex, { type: "txt", name: file.name, content: text });

  const PAGE_SIZE = 3000;
  const pages = [];
  for (let i = 0; i < text.length; i += PAGE_SIZE) {
    pages.push({
      documentId: fileIndex,
      pageNumber: pages.length + 1,
      documentTitle: file.name,
      content: text.slice(i, i + PAGE_SIZE),
    });
  }
  if (pages.length === 0) {
    pages.push({
      documentId: fileIndex,
      pageNumber: 1,
      documentTitle: file.name,
      content: "",
    });
  }
  return pages;
}

async function readSrtFile(file, fileIndex) {
  const text = await file.text();
  const entries = parseSrt(text);

  documentMeta.set(fileIndex, {
    type: "srt",
    name: file.name,
    entries,
  });

  const pages = entries.map((entry) => ({
    documentId: fileIndex,
    pageNumber: entry.index,
    documentTitle: file.name,
    content: entry.text,
    startTime: entry.startTime,
  }));

  if (pages.length === 0) {
    pages.push({
      documentId: fileIndex,
      pageNumber: 1,
      documentTitle: file.name,
      content: "",
      startTime: null,
    });
  }

  return pages;
}

async function readPdfFile(file, fileIndex) {
  const arrayBuffer = await file.arrayBuffer();
  pdfBuffers.set(fileIndex, arrayBuffer.slice(0));
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
  }).promise;

  const documentTitle = pdf.title || file.name;
  documentMeta.set(fileIndex, { type: "pdf", name: file.name });

  return Promise.all(
    Array.from({ length: pdf.numPages }, async (_, pageIndex) => ({
      documentId: fileIndex,
      pageNumber: pageIndex + 1,
      documentTitle,
      content: await pdf
        .getPage(pageIndex + 1)
        .then((p) => p.getTextContent())
        .then((c) => c.items.map((i) => i.str).join(" ")),
    })),
  );
}

const readFiles = async (files) =>
  Promise.all(
    files.map(async (file, fileIndex) => {
      const nameLower = file.name.toLowerCase();
      const isTxt = file.type === "text/plain" || nameLower.endsWith(".txt");
      const isSrt =
        file.type === "application/x-subrip" ||
        file.type === "text/x-srt" ||
        nameLower.endsWith(".srt");

      let pages;
      if (isSrt) {
        pages = await readSrtFile(file, fileIndex);
      } else if (isTxt) {
        pages = await readTxtFile(file, fileIndex);
      } else {
        pages = await readPdfFile(file, fileIndex);
      }

      PROGRESS_BAR.value += 1 / files.length;
      return pages;
    }),
  );

PDF_INPUT.setAttribute(
  "accept",
  ".pdf,.txt,.srt,application/pdf,text/plain,application/x-subrip,text/x-srt",
);

PDF_INPUT.addEventListener("input", async () => {
  Array.from(document.getElementsByClassName("hide-on-start")).forEach(
    (element) => {
      element.style.display = "none";
    },
  );

  PROGRESS_BAR.removeAttribute("value");
  pdfBuffers.clear();
  documentMeta.clear();
  currentDocumentId = null;
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  viewerFrame.src = "about:blank";
  CANVAS_VIEWER.style.display = "block";
  TEXT_VIEWER.style.display = "none";
  TEXT_VIEWER.textContent = "";
  INPUT_LIST.innerHTML = "";
  OUTPUT_LIST.innerHTML = "";

  const files = Array.from(PDF_INPUT.files);
  const pages = await readFiles(files);

  const chunks = pages.flatMap((pages) => {
    const chunks = [];
    let current = {
      content: "",
      pageNumber: null,
      documentTitle: null,
      documentId: null,
      startTime: null,
    };

    for (const page of pages) {
      for (const sentence of page.content.match(/[^.]+\.(?= |\n)/g) ?? [
        page.content,
      ]) {
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
  });

  const documentChunkLengths = Object.fromEntries(
    Object.entries(Object.groupBy(chunks, (item) => item.documentId)).map(
      ([id, items]) => [id, items.length],
    ),
  );

  files.forEach(async (file, documentId) => {
    const listItem = document.createElement("li");
    const infoDiv = document.createElement("div");
    const titleSpan = document.createElement("span");
    titleSpan.textContent = file.name;
    const chunkCountSpan = document.createElement("span");
    chunkCountSpan.classList.add("light-text");
    chunkCountSpan.textContent = documentChunkLengths[documentId] + " chunks";
    const progressBar = document.createElement("progress");
    progressBar.id = "input-progress-" + documentId;
    progressBar.value = 0;
    progressBar.max = 1;
    infoDiv.append(titleSpan, chunkCountSpan);
    listItem.append(infoDiv, progressBar);
    INPUT_LIST.append(listItem);
  });

  PROGRESS_BAR.removeAttribute("value");

  const MAX_WORKERS = Math.max(navigator.hardwareConcurrency, 4);
  const taskQueue = [];

  function createWorker() {
    const entry = {
      worker: new Worker("./embedding-worker.js", { type: "module" }),
      busy: false,
    };

    entry.worker.onmessage = ({ data }) => {
      PROGRESS_BAR.value += 1 / chunks.length;
      const documentProgressBar = document.getElementById(
        "input-progress-" + data.documentId,
      );
      documentProgressBar.value += 1 / documentChunkLengths[data.documentId];
      if (documentProgressBar.value >= 1 - EPSILON)
        documentProgressBar.remove();
      entry.busy = false;
      entry.resolve(data.embedding);
      entry.resolve = null;
      runNext();
    };

    return entry;
  }

  const workerPool = Array.from(
    { length: Math.min(MAX_WORKERS, chunks.length) },
    createWorker,
  );

  function runNext() {
    if (taskQueue.length === 0) return;
    const freeWorker = workerPool.find((w) => !w.busy);
    if (!freeWorker) return;

    const { content, resolve } = taskQueue.shift();
    freeWorker.busy = true;
    freeWorker.resolve = resolve;
    freeWorker.worker.postMessage(content);
  }

  const embeddings = await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((resolve) => {
          taskQueue.push({
            content: { content: chunk.content, documentId: chunk.documentId },
            resolve,
          });
          runNext();
        }),
    ),
  );

  workerPool.forEach(({ worker }) => worker.terminate());

  PROGRESS_BAR.value = 0;

  const queryEmbeddingWorker = new Worker("./embedding-worker.js", {
    type: "module",
  });

  QUERY_BUTTON.disabled = false;
  QUERY_BUTTON.addEventListener("click", async () => {
    QUERY_BUTTON.disabled = true;
    const query = QUERY_TEXT.value;
    OUTPUT_LIST.innerHTML = "";

    const queryEmbeddingPromise = new Promise((resolve) => {
      const handler = (event) => {
        queryEmbeddingWorker.removeEventListener("message", handler);
        resolve(event.data.embedding);
      };
      queryEmbeddingWorker.addEventListener("message", handler);
    });
    queryEmbeddingWorker.postMessage({ content: query, documentId: -1 });
    const queryEmbedding = await queryEmbeddingPromise;

    const cosineSimilarity = (a, b) =>
      a.reduce((dot, val, i) => dot + val * b[i], 0) /
      (Math.sqrt(a.reduce((sum, val) => sum + val * val, 0)) *
        Math.sqrt(b.reduce((sum, val) => sum + val * val, 0)));

    const n = 25;

    const nClosest = embeddings
      .map((embedding, index) => ({
        index,
        distance: 1 - cosineSimilarity(embedding, queryEmbedding),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, n);

    const closestChunks = nClosest.map(({ index, distance }) => {
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

      const meta = documentMeta.get(chunk.documentId);
      if (meta?.type === "srt") {
        pageSpan.textContent = chunk.startTime
          ? formatTimestamp(chunk.startTime)
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
        OUTPUT_LIST.querySelectorAll("li").forEach((li) =>
          li.removeAttribute("data-active"),
        );
        listItem.setAttribute("data-active", "true");
        renderPage(chunk.documentId, chunk.pageNumber, chunk.content);
      });

      OUTPUT_LIST.append(listItem);
    });

    QUERY_BUTTON.disabled = false;
  });
});
