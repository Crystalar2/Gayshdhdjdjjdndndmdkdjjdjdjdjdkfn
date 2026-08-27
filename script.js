/* =========================================================
   Leaflet — PDF eBook Reader
   Vanilla JS + PDF.js. No build step, no framework.
   ========================================================= */

(function () {
  "use strict";

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  // ---------------- DOM ----------------
  const fileInput = document.getElementById("fileInput");
  const importBtn = document.getElementById("importBtn");
  const placeholderImportBtn = document.getElementById("placeholderImportBtn");

  const placeholder = document.getElementById("placeholder");
  const loading = document.getElementById("loading");
  const loadingText = document.getElementById("loadingText");
  const bookViewer = document.getElementById("bookViewer");

  const book = document.getElementById("book");
  const leftPanel = document.getElementById("leftPanel");
  const rightPanel = document.getElementById("rightPanel");
  const leftCanvas = document.getElementById("leftCanvas");
  const rightCanvas = document.getElementById("rightCanvas");
  const leftPageLabel = document.getElementById("leftPageLabel");
  const rightPageLabel = document.getElementById("rightPageLabel");

  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const edgePrev = document.getElementById("edgePrev");
  const edgeNext = document.getElementById("edgeNext");

  const pageForm = document.getElementById("pageForm");
  const pageInput = document.getElementById("pageInput");
  const pageCountEl = document.getElementById("pageCount");

  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const zoomLevelEl = document.getElementById("zoomLevel");

  const bgColorPicker = document.getElementById("bgColorPicker");
  const textColorPicker = document.getElementById("textColorPicker");
  const resetColorsBtn = document.getElementById("resetColorsBtn");

  const lensBtn = document.getElementById("lensBtn");
  const lensOverlay = document.getElementById("lensOverlay");
  const selectionBox = document.getElementById("selectionBox");
  const ocrBar = document.getElementById("ocrBar");
  const ocrStatus = document.getElementById("ocrStatus");
  const ocrTextWrap = document.getElementById("ocrTextWrap");
  const ocrText = document.getElementById("ocrText");
  const ocrCopyBtn = document.getElementById("ocrCopyBtn");
  const ocrCloseBtn = document.getElementById("ocrCloseBtn");

  // ---------------- State ----------------
  let pdfDoc = null;
  let pageCount = 0;
  let currentAnchor = 1;       // left page of the spread, or the lone page number
  let zoomFactor = 1;          // user zoom multiplier on top of fit-to-screen
  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 3.0;
  const ZOOM_STEP = 0.2;

  let bgColor = bgColorPicker.value;
  let textColor = textColorPicker.value;

  let leftOriginal = null;     // cached raw ImageData for instant recolor
  let rightOriginal = null;

  let renderToken = 0;         // guards against out-of-order async renders
  let resizeTimer = null;

  const mobileQuery = window.matchMedia("(max-width: 760px)");
  const isMobile = () => mobileQuery.matches;

  // ---------------- Helpers ----------------

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m
      ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
      : [0, 0, 0];
  }

  // Duotone remap: original luminance interpolates between textColor (dark)
  // and bgColor (light). This is what lets an arbitrary "page" and "ink"
  // color be applied to a PDF that was rendered as flat pixels.
  function applyDuotone(canvas, original) {
    if (!original) return;
    const ctx = canvas.getContext("2d");
    const clone = new ImageData(
      new Uint8ClampedArray(original.data),
      original.width,
      original.height
    );
    const [br, bgc, bb] = hexToRgb(bgColor);
    const [tr, tgc, tb] = hexToRgb(textColor);
    const d = clone.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = (d[i] + d[i + 1] + d[i + 2]) / 765; // 0..1
      d[i] = tr + (br - tr) * lum;
      d[i + 1] = tgc + (bgc - tgc) * lum;
      d[i + 2] = tb + (bb - tb) * lum;
    }
    ctx.putImageData(clone, 0, 0);
  }

  function spreadFor(anchor) {
    if (anchor <= 1) return [null, 1];
    const left = anchor % 2 === 0 ? anchor : anchor - 1;
    const right = left + 1 <= pageCount ? left + 1 : null;
    return [left, right];
  }

  function clampAnchor(n) {
    if (n < 1) return 1;
    if (n > pageCount) return pageCount;
    return n;
  }

  // ---------------- Rendering ----------------

  async function renderPageRaw(num, canvas, fitScale) {
    const page = await pdfDoc.getPage(num);
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: fitScale * zoomFactor * dpr });

    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    canvas.style.width = Math.round(viewport.width / dpr) + "px";
    canvas.style.height = Math.round(viewport.height / dpr) + "px";

    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  function computeFitScale(refViewportUnscaled, mobile, leftExists, rightExists) {
    const pad = 48;
    const spine = mobile ? 0 : 18;
    const availW = Math.max(bookViewer.clientWidth - pad, 120);
    const availH = Math.max(bookViewer.clientHeight - pad, 120);

    const pagesAcross = mobile ? 1 : (leftExists && rightExists ? 2 : 1);
    const neededW = refViewportUnscaled.width * pagesAcross + (pagesAcross === 2 ? spine : 0);
    const neededH = refViewportUnscaled.height;

    const scaleW = availW / neededW;
    const scaleH = availH / neededH;
    return Math.max(Math.min(scaleW, scaleH), 0.1);
  }

  async function renderSpread(anchor) {
    if (!pdfDoc) return;
    const myToken = ++renderToken;
    const mobile = isMobile();

    currentAnchor = clampAnchor(anchor);

    let leftNum, rightNum;
    if (mobile) {
      leftNum = currentAnchor;
      rightNum = null;
    } else {
      [leftNum, rightNum] = spreadFor(currentAnchor);
    }

    // reference page for fit-to-screen math
    const refNum = leftNum || rightNum;
    const refPage = await pdfDoc.getPage(refNum);
    if (myToken !== renderToken) return;
    const refViewport = refPage.getViewport({ scale: 1 });
    const fitScale = computeFitScale(refViewport, mobile, !!leftNum, !!(rightNum && !mobile));

    book.classList.remove("single-left", "single-right");
    if (!mobile) {
      if (leftNum && !rightNum) book.classList.add("single-left");
      else if (!leftNum && rightNum) book.classList.add("single-right");
    }

    const tasks = [];

    if (leftNum) {
      tasks.push(
        renderPageRaw(leftNum, leftCanvas, fitScale).then((img) => {
          leftOriginal = img;
          applyDuotone(leftCanvas, leftOriginal);
          leftPageLabel.textContent = leftNum;
        })
      );
    } else {
      leftOriginal = null;
      leftPageLabel.textContent = "";
    }

    if (!mobile && rightNum) {
      tasks.push(
        renderPageRaw(rightNum, rightCanvas, fitScale).then((img) => {
          rightOriginal = img;
          applyDuotone(rightCanvas, rightOriginal);
          rightPageLabel.textContent = rightNum;
        })
      );
    } else {
      rightOriginal = null;
      rightPageLabel.textContent = "";
    }

    await Promise.all(tasks);
    if (myToken !== renderToken) return;

    bookViewer.classList.toggle("is-zoomed", zoomFactor > 1.02);

    // toolbar state
    const firstShownPage = leftNum || rightNum;
    const lastShownPage = rightNum || leftNum;
    pageInput.value = mobile ? currentAnchor : firstShownPage;
    prevBtn.disabled = (mobile ? currentAnchor : firstShownPage) <= 1;
    nextBtn.disabled = (mobile ? currentAnchor : lastShownPage) >= pageCount;
    zoomLevelEl.textContent = Math.round(zoomFactor * 100) + "%";
    zoomOutBtn.disabled = zoomFactor <= ZOOM_MIN + 1e-6;
    zoomInBtn.disabled = zoomFactor >= ZOOM_MAX - 1e-6;
  }

  function step() {
    return isMobile() ? 1 : 2;
  }

  function goNext() {
    if (!pdfDoc) return;
    const s = step();
    let target = currentAnchor + s;
    if (isMobile()) {
      target = Math.min(target, pageCount);
    } else {
      if (target > pageCount) target = pageCount;
    }
    renderSpread(target);
  }

  function goPrev() {
    if (!pdfDoc) return;
    const s = step();
    let target = currentAnchor - s;
    if (target < 1) target = 1;
    renderSpread(target);
  }

  function goToPage(numRaw) {
    if (!pdfDoc) return;
    let num = parseInt(numRaw, 10);
    if (isNaN(num)) return;
    num = Math.min(Math.max(num, 1), pageCount);
    if (isMobile() || num === 1) {
      renderSpread(num);
    } else {
      renderSpread(num % 2 === 0 ? num : num - 1);
    }
  }

  // ---------------- Loading a PDF ----------------

  async function loadFile(file) {
    if (!window.pdfjsLib) {
      alert(
        "The PDF engine hasn't loaded. Leaflet needs an internet connection " +
        "the first time it runs so it can fetch PDF.js, then it will keep " +
        "working from your browser's cache. Please check your connection and reload."
      );
      return;
    }
    if (!file || file.type !== "application/pdf") {
      alert("Please choose a PDF file.");
      return;
    }
    placeholder.classList.add("hidden");
    bookViewer.classList.add("hidden");
    loading.classList.remove("hidden");
    loadingText.textContent = "Opening \u201c" + file.name + "\u201d\u2026";

    try {
      const buf = await file.arrayBuffer();
      const task = pdfjsLib.getDocument({ data: buf });
      pdfDoc = await task.promise;
      pageCount = pdfDoc.numPages;

      pageCountEl.textContent = pageCount;
      pageInput.min = 1;
      pageInput.max = pageCount;
      pageInput.disabled = false;
      prevBtn.disabled = false;
      nextBtn.disabled = false;
      zoomInBtn.disabled = false;
      zoomOutBtn.disabled = false;
      lensBtn.disabled = false;

      zoomFactor = 1;
      leftOriginal = null;
      rightOriginal = null;

      loading.classList.add("hidden");
      bookViewer.classList.remove("hidden");

      await renderSpread(1);
    } catch (err) {
      console.error(err);
      loading.classList.add("hidden");
      placeholder.classList.remove("hidden");
      alert("Sorry, that PDF couldn't be opened. It may be corrupted, password-protected, or an unsupported format.");
    }
  }

  // ---------------- Events ----------------

  importBtn.addEventListener("click", () => fileInput.click());
  placeholderImportBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFile(f);
    fileInput.value = "";
  });

  prevBtn.addEventListener("click", goPrev);
  nextBtn.addEventListener("click", goNext);
  edgePrev.addEventListener("click", goPrev);
  edgeNext.addEventListener("click", goNext);

  pageForm.addEventListener("submit", (e) => {
    e.preventDefault();
    goToPage(pageInput.value);
    pageInput.blur();
  });
  pageInput.addEventListener("change", () => goToPage(pageInput.value));

  zoomInBtn.addEventListener("click", () => {
    zoomFactor = Math.min(ZOOM_MAX, +(zoomFactor + ZOOM_STEP).toFixed(2));
    renderSpread(currentAnchor);
  });
  zoomOutBtn.addEventListener("click", () => {
    zoomFactor = Math.max(ZOOM_MIN, +(zoomFactor - ZOOM_STEP).toFixed(2));
    renderSpread(currentAnchor);
  });

  bgColorPicker.addEventListener("input", () => {
    bgColor = bgColorPicker.value;
    if (leftOriginal) applyDuotone(leftCanvas, leftOriginal);
    if (rightOriginal) applyDuotone(rightCanvas, rightOriginal);
  });
  textColorPicker.addEventListener("input", () => {
    textColor = textColorPicker.value;
    if (leftOriginal) applyDuotone(leftCanvas, leftOriginal);
    if (rightOriginal) applyDuotone(rightCanvas, rightOriginal);
  });
  resetColorsBtn.addEventListener("click", () => {
    bgColor = "#ffffff";
    textColor = "#000000";
    bgColorPicker.value = bgColor;
    textColorPicker.value = textColor;
    if (leftOriginal) applyDuotone(leftCanvas, leftOriginal);
    if (rightOriginal) applyDuotone(rightCanvas, rightOriginal);
  });

  // Keyboard navigation
  document.addEventListener("keydown", (e) => {
    if (!pdfDoc) return;
    if (document.activeElement === pageInput) return;
    if (e.key === "ArrowRight") goNext();
    else if (e.key === "ArrowLeft") goPrev();
  });

  // Responsive: re-render on layout-changing resize
  let lastMobile = isMobile();
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!pdfDoc) return;
      const nowMobile = isMobile();
      if (nowMobile !== lastMobile) {
        lastMobile = nowMobile;
      }
      renderSpread(currentAnchor);
    }, 180);
  });

  // Drag & drop support
  ["dragover", "drop"].forEach((evt) =>
    document.addEventListener(evt, (e) => e.preventDefault())
  );
  document.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // ---------------- Lens (copy text from the page via OCR) ----------------
  // Drag a box over the (already-rendered) page canvas; the selection is
  // cropped from the ORIGINAL page pixels (pre-duotone) at full render
  // resolution and handed to Tesseract.js, which runs the Tesseract OCR
  // engine entirely client-side (WASM, loaded from CDN). Recognized text
  // is shown in a bottom bar with a Copy button.

  let lensActive = false;
  let selecting = false;
  let selStartX = 0, selStartY = 0;
  let ocrWorker = null;          // lazily-created, reused across selections
  let ocrWorkerPromise = null;
  let ocrRunToken = 0;           // guards against overlapping/late OCR results

  function getOcrWorker() {
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = Tesseract.createWorker("eng");
    }
    return ocrWorkerPromise;
  }

  function setLensActive(on) {
    if (on && !pdfDoc) return;
    lensActive = on;
    lensBtn.classList.toggle("active", on);
    lensOverlay.classList.toggle("hidden", !on);
    if (!on) {
      selecting = false;
      selectionBox.classList.add("hidden");
    }
  }

  function toggleLens() {
    setLensActive(!lensActive);
  }

  function closeOcrBar() {
    ocrBar.classList.add("hidden");
    ocrRunToken++; // invalidate any in-flight recognition
  }

  function pointInRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function rectFromPoints(x1, y1, x2, y2) {
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      right: Math.max(x1, x2),
      bottom: Math.max(y1, y2),
    };
  }

  // Crop a region (in that canvas's own pixel space) out of a cached,
  // pre-duotone ImageData snapshot, so OCR always sees full black-on-white
  // contrast regardless of the reader's current page/ink color theme.
  function cropOriginalToCanvas(original, sx, sy, sw, sh) {
    const full = document.createElement("canvas");
    full.width = original.width;
    full.height = original.height;
    full.getContext("2d").putImageData(original, 0, 0);

    const crop = document.createElement("canvas");
    crop.width = Math.max(1, Math.round(sw));
    crop.height = Math.max(1, Math.round(sh));
    const cctx = crop.getContext("2d");
    // Upscale small selections a bit; helps OCR accuracy on small text.
    const upscale = crop.width < 300 ? Math.min(3, 300 / crop.width) : 1;
    if (upscale > 1) {
      crop.width = Math.round(crop.width * upscale);
      crop.height = Math.round(crop.height * upscale);
    }
    cctx.imageSmoothingEnabled = true;
    cctx.drawImage(full, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
    return crop;
  }

  async function runOcrOnSelection(canvas, original, clientRect) {
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;

    // Clamp the selection to the canvas bounds, then map to canvas pixels.
    const left = Math.max(clientRect.left, canvasRect.left);
    const top = Math.max(clientRect.top, canvasRect.top);
    const right = Math.min(clientRect.right, canvasRect.right);
    const bottom = Math.min(clientRect.bottom, canvasRect.bottom);
    if (right - left < 4 || bottom - top < 4) return;

    const sx = (left - canvasRect.left) * scaleX;
    const sy = (top - canvasRect.top) * scaleY;
    const sw = (right - left) * scaleX;
    const sh = (bottom - top) * scaleY;

    const source = original
      ? cropOriginalToCanvas(original, sx, sy, sw, sh)
      : (() => {
          // Fallback: no cached original (shouldn't normally happen) —
          // crop straight from the live canvas.
          const crop = document.createElement("canvas");
          crop.width = Math.max(1, Math.round(sw));
          crop.height = Math.max(1, Math.round(sh));
          crop.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
          return crop;
        })();

    const myRun = ++ocrRunToken;
    ocrBar.classList.remove("hidden");
    ocrTextWrap.classList.add("hidden");
    ocrStatus.textContent = "Reading text\u2026";

    try {
      const worker = await getOcrWorker();
      if (myRun !== ocrRunToken) return;
      const { data } = await worker.recognize(source);
      if (myRun !== ocrRunToken) return;

      const text = (data && data.text ? data.text : "").trim();
      if (!text) {
        ocrStatus.textContent = "No text found in that selection \u2014 try a tighter box around the words.";
        ocrTextWrap.classList.add("hidden");
      } else {
        ocrStatus.textContent = "Copied text from the page:";
        ocrText.value = text;
        ocrTextWrap.classList.remove("hidden");
      }
    } catch (err) {
      console.error(err);
      if (myRun !== ocrRunToken) return;
      ocrStatus.textContent = "Couldn't read that selection. Please try again.";
      ocrTextWrap.classList.add("hidden");
    }
  }

  lensBtn.addEventListener("click", toggleLens);
  ocrCloseBtn.addEventListener("click", closeOcrBar);

  lensOverlay.addEventListener("pointerdown", (e) => {
    if (!lensActive) return;
    selecting = true;
    selStartX = e.clientX;
    selStartY = e.clientY;
    selectionBox.style.left = selStartX + "px";
    selectionBox.style.top = selStartY + "px";
    selectionBox.style.width = "0px";
    selectionBox.style.height = "0px";
    selectionBox.classList.remove("hidden");
    lensOverlay.setPointerCapture(e.pointerId);
  });

  lensOverlay.addEventListener("pointermove", (e) => {
    if (!lensActive || !selecting) return;
    const r = rectFromPoints(selStartX, selStartY, e.clientX, e.clientY);
    selectionBox.style.left = r.left + "px";
    selectionBox.style.top = r.top + "px";
    selectionBox.style.width = (r.right - r.left) + "px";
    selectionBox.style.height = (r.bottom - r.top) + "px";
  });

  lensOverlay.addEventListener("pointerup", (e) => {
    if (!lensActive || !selecting) return;
    selecting = false;
    const r = rectFromPoints(selStartX, selStartY, e.clientX, e.clientY);
    selectionBox.classList.add("hidden");

    const w = r.right - r.left;
    const h = r.bottom - r.top;
    if (w < 8 || h < 8) return; // treat as a stray click, not a drag

    // Which page panel did the drag start on? (getBoundingClientRect is
    // 0x0 for a canvas that's currently display:none — e.g. the right
    // page on mobile or a single-page spread — so that's checked too.)
    const leftRect = leftCanvas.getBoundingClientRect();
    const rightRect = rightCanvas.getBoundingClientRect();
    const rightVisible = rightRect.width > 0 && rightRect.height > 0;
    const leftVisible = leftRect.width > 0 && leftRect.height > 0;

    if (rightVisible && pointInRect(selStartX, selStartY, rightRect)) {
      runOcrOnSelection(rightCanvas, rightOriginal, r);
    } else if (leftVisible && pointInRect(selStartX, selStartY, leftRect)) {
      runOcrOnSelection(leftCanvas, leftOriginal, r);
    }
    // else: drag started off either page (spine/margins) — ignore silently
  });

  // Cancel an in-progress drag if the pointer leaves the window/tab.
  lensOverlay.addEventListener("pointercancel", () => {
    selecting = false;
    selectionBox.classList.add("hidden");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (lensActive) setLensActive(false);
      if (!ocrBar.classList.contains("hidden")) closeOcrBar();
    }
  });

  ocrCopyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ocrText.value);
    } catch (err) {
      // Fallback for browsers/contexts without Clipboard API access.
      ocrText.select();
      document.execCommand("copy");
    }
    ocrCopyBtn.classList.add("copied");
    const label = ocrCopyBtn.querySelector("span");
    const original = label.textContent;
    label.textContent = "Copied!";
    setTimeout(() => {
      ocrCopyBtn.classList.remove("copied");
      label.textContent = original;
    }, 1400);
  });
})();
