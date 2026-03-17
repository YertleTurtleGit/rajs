import * as pdfjsLib from "./lib/pdfjs/pdf.min.js";
pdfjsLib.GlobalWorkerOptions.workerSrc = "./lib/pdfjs/pdf.worker.min.js";

const EPSILON = 0.0001;

const PDF_INPUT = document.getElementById("file-input");
const PROGRESS_BAR = document.getElementById("progress-bar");
const QUERY_TEXT = document.getElementById("query-text");
const QUERY_BUTTON = document.getElementById("query-submit");
const INPUT_LIST = document.getElementById("input-list");
const OUTPUT_LIST = document.getElementById("output-list");
const CANVAS_VIEWER = document.getElementById("canvas-viewer");

const CHUNK_SIZE = 800;

// Store loaded PDF documents by documentId for later rendering
const pdfDocuments = new Map();

const readPDFs = async (files) =>
  Promise.all(
    files.map(async (file, fileIndex) => {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      // Store the pdf document reference for later page rendering
      pdfDocuments.set(fileIndex, pdf);

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

let currentDocumentId = null;

async function renderDocument(documentId) {
  const pdf = pdfDocuments.get(documentId);
  if (!pdf) return;

  CANVAS_VIEWER.innerHTML = "";
  currentDocumentId = documentId;

  const width = CANVAS_VIEWER.clientWidth || 800;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);

    const canvas = document.createElement("canvas");
    canvas.id = `pdf-page-${documentId}-${pageNumber}`;
    CANVAS_VIEWER.append(canvas);

    const viewport = page.getViewport({ scale: 1 });
    const scale = width / viewport.width;
    const scaledViewport = page.getViewport({ scale });

    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;

    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: scaledViewport,
    }).promise;
  }
}

async function renderPage(documentId, pageNumber) {
  // Re-render only if switching to a different document
  if (currentDocumentId !== documentId) {
    await renderDocument(documentId);
  }

  const target = document.getElementById(
    `pdf-page-${documentId}-${pageNumber}`,
  );
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

PDF_INPUT.addEventListener("input", async () => {
  PDF_INPUT.remove();
  PROGRESS_BAR.value = 0;
  pdfDocuments.clear();
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

function handleResize() {
  //here
}
window.addEventListener("resize", handleResize);
