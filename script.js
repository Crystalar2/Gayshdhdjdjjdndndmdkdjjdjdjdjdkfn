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
})();
