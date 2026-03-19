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

const CHUNK_SIZE = 800;

// Store raw ArrayBuffers by documentId so we can push them into the viewer
const pdfBuffers = new Map();

// Track the current blob URL so we can revoke it when switching documents
let currentBlobUrl = null;

// Create a persistent iframe inside CANVAS_VIEWER for the PDF.js full viewer
const viewerFrame = document.createElement("iframe");
viewerFrame.style.cssText = "width:100%;height:100%;border:none;display:block;";
CANVAS_VIEWER.style.padding = "0";
CANVAS_VIEWER.append(viewerFrame);

const VIEWER_URL = "./lib/pdfjs/web/viewer.html";

let currentDocumentId = null;

/**
 * Wait for PDFViewerApplication inside the iframe to be fully initialised.
 */
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

/**
 * Load a document into the iframe viewer and jump to the target page.
 */
async function renderPage(documentId, pageNumber) {
  const buffer = pdfBuffers.get(documentId);
  if (!buffer) return;

  if (currentDocumentId !== documentId) {
    currentDocumentId = documentId;

    // Revoke previous blob URL to free memory
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }

    // Create a blob URL — most reliable way to feed binary data to the viewer
    const blob = new Blob([buffer], { type: "application/pdf" });
    currentBlobUrl = URL.createObjectURL(blob);

    // Append ?file= (empty) to suppress the default Mozilla sample PDF,
    // then load our blob URL once the viewer is ready
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
      },
      { once: true },
    );
  } else {
    // Same document already loaded — just scroll
    const app = viewerFrame.contentWindow?.PDFViewerApplication;
    app?.pdfViewer?.scrollPageIntoView({ pageNumber });
  }
}

const readPDFs = async (files) =>
  Promise.all(
    files.map(async (file, fileIndex) => {
      const arrayBuffer = await file.arrayBuffer();

      // Store a copy BEFORE passing to pdfjsLib — PDF.js transfers (detaches)
      // the underlying ArrayBuffer during parsing, leaving the original empty.
      pdfBuffers.set(fileIndex, arrayBuffer.slice(0));
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) })
        .promise;

      const documentTitle = pdf.title || file.name;
      const pages = await Promise.all(
        Array.from({ length: pdf.numPages }, async (_, pageIndex) => {
          return {
            documentId: fileIndex,
            pageNumber: pageIndex + 1,
            documentTitle: documentTitle,
            content: await pdf
              .getPage(pageIndex + 1)
              .then((p) => p.getTextContent())
              .then((c) => c.items.map((i) => i.str).join(" ")),
          };
        }),
      );
      PROGRESS_BAR.value += 1 / files.length;
      return pages;
    }),
  );

PDF_INPUT.addEventListener("input", async () => {
  PDF_INPUT.remove();
  PROGRESS_BAR.value = 0;
  pdfBuffers.clear();
  currentDocumentId = null;
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  viewerFrame.src = "about:blank";
  INPUT_LIST.innerHTML = "";
  OUTPUT_LIST.innerHTML = "";

  const files = Array.from(PDF_INPUT.files);
  const pages = await readPDFs(files);

  const chunks = pages.flatMap((pages) => {
    const chunks = [];
    let current = {
      content: "",
      pageNumber: null,
      documentTitle: null,
      documentId: null,
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
          };
        } else {
          current.content += sentence;
          if (!current.pageNumber) {
            current.pageNumber = page.pageNumber;
            current.documentTitle = page.documentTitle;
            current.documentId = page.documentId;
          }
        }
      }
    }

    if (current.content.trim())
      chunks.push({ ...current, content: current.content.trim() });
    return chunks;
  });

  const documentChunkLenghts = Object.fromEntries(
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
    chunkCountSpan.textContent = documentChunkLenghts[documentId] + " chunks";
    const progressBar = document.createElement("progress");
    progressBar.id = "input-progress-" + documentId;
    progressBar.value = 0;
    progressBar.max = 1;
    infoDiv.append(titleSpan, chunkCountSpan);
    listItem.append(infoDiv, progressBar);
    INPUT_LIST.append(listItem);
  });

  PROGRESS_BAR.value = 0;

  const MAX_WORKERS = navigator.hardwareConcurrency;
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
      documentProgressBar.value += 1 / documentChunkLenghts[data.documentId];
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

    const n = 10;

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
      pageSpan.textContent = "p." + chunk.pageNumber;

      const contentDiv = document.createElement("div");
      contentDiv.textContent = chunk.content;

      infoDiv.append(scoreSpan, sourceSpan, pageSpan);
      listItem.append(infoDiv, contentDiv);

      listItem.addEventListener("click", () => {
        OUTPUT_LIST.querySelectorAll("li").forEach((li) =>
          li.removeAttribute("data-active"),
        );
        listItem.setAttribute("data-active", "true");
        renderPage(chunk.documentId, chunk.pageNumber);
      });

      OUTPUT_LIST.append(listItem);
    });

    QUERY_BUTTON.disabled = false;
  });
});