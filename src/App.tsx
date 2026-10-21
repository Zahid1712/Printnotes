import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { PDFDocument } from "pdf-lib";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url
).toString();

type Mode = "auto" | "all" | "none";
type Tone = "grayscale" | "mono";
type Cleanup = "light" | "balanced" | "strong";
type Slide = {
  id: string;
  fileId: string;
  fileName: string;
  pageNumber: number;
  width: number;
  height: number;
  preview: string;
  canvas: HTMLCanvasElement;
};
type SourceFile = { id: string; name: string; pages: number; size: number };

const uid = () => Math.random().toString(36).slice(2, 10);
const fmtSize = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;

function processCanvas(
  source: HTMLCanvasElement,
  mode: Mode,
  tone: Tone,
  threshold: number,
  inkSaver: boolean,
  cleanup: Cleanup,
  clarity: number
) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0);

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;
  const width = canvas.width;
  const height = canvas.height;

  const luminanceAt = (x: number, y: number) => {
    const i = (Math.max(0, Math.min(height - 1, y)) * width +
      Math.max(0, Math.min(width - 1, x))) * 4;
    return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  };

  // Decide whether this is a dark-background slide from several corner patches.
  // This is more reliable than whole-slide average brightness because a white
  // NCERT photo can otherwise make a dark lecture slide look "bright".
  const patchW = Math.max(1, Math.floor(width * 0.08));
  const patchH = Math.max(1, Math.floor(height * 0.08));
  const cornerStarts: Array<[number, number]> = [
    [0, 0],
    [Math.max(0, width - patchW), 0],
    [0, Math.max(0, height - patchH)],
    [Math.max(0, width - patchW), Math.max(0, height - patchH)]
  ];
  let darkCorners = 0;
  for (const [sx, sy] of cornerStarts) {
    let sum = 0;
    let count = 0;
    const stepX = Math.max(1, Math.floor(patchW / 18));
    const stepY = Math.max(1, Math.floor(patchH / 18));
    for (let y = sy; y < Math.min(height, sy + patchH); y += stepY) {
      for (let x = sx; x < Math.min(width, sx + patchW); x += stepX) {
        sum += luminanceAt(x, y);
        count++;
      }
    }
    if (sum / Math.max(1, count) < 125) darkCorners++;
  }

  const autoDarkSlide = darkCorners >= 2;
  const fullInvert = mode === "all";
  const adaptiveInvert = mode === "auto" && autoDarkSlide;
  const cleanupStrength = cleanup === "light" ? 0.22 : cleanup === "balanced" ? 0.42 : 0.62;
  const contrast = 1 + clarity / 500; // Keep sharpening subtle to avoid heavy-looking outlines.

  // Build a small blurred luminance map. Its local average lets us distinguish
  // dark slide backgrounds from dark text printed inside a white NCERT photo.
  const mapW = Math.max(1, Math.ceil(width / 18));
  const mapH = Math.max(1, Math.ceil(height / 18));
  const mapCanvas = document.createElement("canvas");
  mapCanvas.width = mapW;
  mapCanvas.height = mapH;
  const mapCtx = mapCanvas.getContext("2d", { willReadFrequently: true })!;
  mapCtx.drawImage(source, 0, 0, mapW, mapH);
  const mapData = mapCtx.getImageData(0, 0, mapW, mapH).data;

  const localLuminance = (x: number, y: number) => {
    const mx = Math.max(0, Math.min(mapW - 1, Math.floor(x / width * mapW)));
    const my = Math.max(0, Math.min(mapH - 1, Math.floor(y / height * mapH)));
    const i = (my * mapW + mx) * 4;
    return 0.299 * mapData[i] + 0.587 * mapData[i + 1] + 0.114 * mapData[i + 2];
  };

  for (let yPos = 0; yPos < height; yPos++) {
    for (let xPos = 0; xPos < width; xPos++) {
      const i = (yPos * width + xPos) * 4;
      let r = px[i], g = px[i + 1], b = px[i + 2];
      let y = 0.299 * r + 0.587 * g + 0.114 * b;

      if (fullInvert) {
        r = 255 - r; g = 255 - g; b = 255 - b;
        y = 0.299 * r + 0.587 * g + 0.114 * b;
      } else if (adaptiveInvert) {
        const nearbyBrightness = localLuminance(xPos, yPos);
        // Invert dark pixels only when their surrounding region is also dark.
        // Dark letters inside a bright NCERT page are therefore preserved.
        if (nearbyBrightness < 138 && y < 125) {
          y = 255 - y;
        }
      }

      if (inkSaver && !fullInvert && !adaptiveInvert && y > 130) {
        const pageBackgroundWeight = Math.min(1, Math.max(0, (y - 130) / 100));
        const brighten = cleanupStrength * pageBackgroundWeight;
        y = y + (255 - y) * brighten;
      }

      y = Math.max(0, Math.min(255, (y - 128) * contrast + 128));
      if (tone === "mono") y = y >= threshold ? 255 : 0;

      px[i] = y;
      px[i + 1] = y;
      px[i + 2] = y;
      px[i + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  mapCanvas.width = 1;
  mapCanvas.height = 1;
  return canvas;
}

export default function App() {
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [mode, setMode] = useState<Mode>("auto");
  const [tone, setTone] = useState<Tone>("grayscale");
  const [threshold, setThreshold] = useState(175);
  const [inkSaver, setInkSaver] = useState(true);
  const [cleanup, setCleanup] = useState<Cleanup>("balanced");
  const [clarity, setClarity] = useState(55);
  const [processedPreviews, setProcessedPreviews] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [filename, setFilename] = useState("PrintNotes.pdf");
  const [dragging, setDragging] = useState(false);
  const [activeSlide, setActiveSlide] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileMap = useRef<Map<string, File>>(new Map());

  useEffect(() => {
    if (!activeSlide && slides.length) setActiveSlide(slides[0].id);
    if (activeSlide && !slides.some(s => s.id === activeSlide)) setActiveSlide(slides[0]?.id ?? null);
  }, [slides, activeSlide]);

  useEffect(() => {
    let cancelled = false;
    const next: Record<string, string> = {};
    // Generate processed thumbnails for the visible workspace preview.
    for (const slide of slides) {
      try {
        const processed = processCanvas(slide.canvas, mode, tone, threshold, inkSaver, cleanup, clarity);
        next[slide.id] = processed.toDataURL("image/jpeg", 0.82);
        processed.width = 1;
        processed.height = 1;
      } catch (e) {
        console.warn("Could not create processed preview", e);
        next[slide.id] = slide.preview;
      }
    }
    if (!cancelled) setProcessedPreviews(next);
    return () => { cancelled = true; };
  }, [slides, mode, tone, threshold, inkSaver, cleanup, clarity]);

  async function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list).filter(f => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
    if (!incoming.length) { setError("Please choose one or more PDF files."); return; }
    setError("");
    setBusy(true);
    try {
      for (const file of incoming) {
        const fileId = uid();
        fileMap.current.set(fileId, file);
        setProgress(`Reading ${file.name}…`);
        const bytes = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        const source: SourceFile = { id: fileId, name: file.name, pages: pdf.numPages, size: file.size };
        const newSlides: Slide[] = [];
        for (let p = 1; p <= pdf.numPages; p++) {
          setProgress(`Rendering ${file.name} · page ${p} of ${pdf.numPages}`);
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext("2d", { alpha: false })!;
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport }).promise;
          newSlides.push({
            id: uid(), fileId, fileName: file.name, pageNumber: p,
            width: viewport.width, height: viewport.height,
            preview: canvas.toDataURL("image/jpeg", 0.7), canvas
          });
        }
        setFiles(prev => [...prev, source]);
        setSlides(prev => [...prev, ...newSlides]);
        await pdf.destroy();
      }
      setProgress("");
    } catch (e) {
      console.error(e);
      setError("A PDF could not be opened. It may be damaged, password-protected, or too large for available browser memory.");
      setProgress("");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function moveSlide(index: number, direction: -1 | 1) {
    const next = [...slides];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setSlides(next);
  }

  function moveFile(index: number, direction: -1 | 1) {
    const nextFiles = [...files];
    const target = index + direction;
    if (target < 0 || target >= nextFiles.length) return;
    [nextFiles[index], nextFiles[target]] = [nextFiles[target], nextFiles[index]];
    const order = new Map(nextFiles.map((f, i) => [f.id, i]));
    setFiles(nextFiles);
    setSlides(prev => [...prev].sort((a, b) => (order.get(a.fileId) ?? 0) - (order.get(b.fileId) ?? 0) || a.pageNumber - b.pageNumber));
  }

  function removeSlide(id: string) {
    setSlides(prev => prev.filter(s => s.id !== id));
  }
  function removeFile(id: string) {
    fileMap.current.delete(id);
    setFiles(prev => prev.filter(f => f.id !== id));
    setSlides(prev => prev.filter(s => s.fileId !== id));
  }
  function clearAll() {
    fileMap.current.clear();
    setFiles([]);
    setSlides([]);
    setError("");
    setProgress("");
  }

  async function exportPdf() {
    if (!slides.length) return;
    setBusy(true);
    setError("");
    try {
      const output = await PDFDocument.create();
      const pageW = 595.2756;
      const pageH = 841.8898;
      const slotH = pageH / 3;
      const totalPages = Math.ceil(slides.length / 3);
      for (let pg = 0; pg < totalPages; pg++) {
        setProgress(`Building A4 page ${pg + 1} of ${totalPages}…`);
        const outPage = output.addPage([pageW, pageH]);
        const batch = slides.slice(pg * 3, pg * 3 + 3);
        for (let slot = 0; slot < batch.length; slot++) {
          const slide = batch[slot];
          const processed = processCanvas(slide.canvas, mode, tone, threshold, inkSaver, cleanup, clarity);
          const data = processed.toDataURL("image/jpeg", 0.94);
          const embedded = await output.embedJpg(data);
          const scale = Math.min(pageW / embedded.width, slotH / embedded.height);
          const w = embedded.width * scale;
          const h = embedded.height * scale;
          const x = (pageW - w) / 2;
          const slotBottom = pageH - (slot + 1) * slotH;
          const y = slotBottom + (slotH - h) / 2;
          outPage.drawImage(embedded, { x, y, width: w, height: h });
          processed.width = 1; processed.height = 1;
        }
      }
      const bytes = await output.save();
      const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename.toLowerCase().endsWith(".pdf") ? filename : `${filename}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setProgress("Your print-ready PDF has been downloaded.");
    } catch (e) {
      console.error(e);
      setError("Export failed. Try fewer or smaller PDFs, then export again.");
      setProgress("");
    } finally {
      setBusy(false);
    }
  }

  const current = slides.find(s => s.id === activeSlide);
  const totalOutputPages = Math.ceil(slides.length / 3);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-icon">P</div><div><strong>PrintNotes</strong><span>Lecture PDFs, print-ready</span></div></div>
        <div className="top-actions"><span className="local-pill"><span className="green-dot"/> Files stay on your device</span><button className="button button-quiet" onClick={clearAll} disabled={!slides.length || busy}>New project</button></div>
      </header>

      <main className="main-wrap">
        <section className="intro">
          <div className="eyebrow"><span className="spark">✦</span> YOUR PRINTING WORKSPACE</div>
          <h1>Less ink. <em>Better notes.</em></h1>
          <p>Combine lecture PDFs, clean up dark slides, and make compact A4 notes in a few clicks.</p>
          <div className="steps"><span className="step active"><b>1</b> Add PDFs</span><i/><span className="step"><b>2</b> Arrange slides</span><i/><span className="step"><b>3</b> Export notes</span></div>
        </section>

        <div className="workspace">
          <aside className="sidebar panel">
            <div className="panel-heading"><div><h2>Your PDFs</h2><p>{files.length} {files.length === 1 ? "file" : "files"} · {slides.length} slides</p></div><button className="icon-button" aria-label="Add PDFs" onClick={() => inputRef.current?.click()}>＋</button></div>
            <input ref={inputRef} className="hidden" type="file" accept="application/pdf,.pdf" multiple onChange={e => e.target.files && addFiles(e.target.files)} />
            <div className={`dropzone ${dragging ? "dragging" : ""}`} onClick={() => inputRef.current?.click()} onDragOver={e => {e.preventDefault();setDragging(true)}} onDragLeave={() => setDragging(false)} onDrop={e => {e.preventDefault();setDragging(false);addFiles(e.dataTransfer.files)}}>
              <div className="upload-icon"><UploadIcon/></div><strong>Drop PDFs here</strong><span>or <u>browse files</u></span><small>Multiple files · PDF only</small>
            </div>
            {files.length > 0 && <div className="file-list">{files.map((file, i) => <div className="file-row" key={file.id}><div className="pdf-icon">PDF</div><div className="file-meta"><strong title={file.name}>{file.name}</strong><span>{file.pages} pages · {fmtSize(file.size)}</span></div><div className="file-actions"><button title="Move file up" onClick={() => moveFile(i, -1)} disabled={i === 0}>↑</button><button title="Move file down" onClick={() => moveFile(i, 1)} disabled={i === files.length - 1}>↓</button><button title="Remove file" onClick={() => removeFile(file.id)}>×</button></div></div>)}</div>}
            {!files.length && <div className="empty-file"><div className="empty-art"><FileIcon/></div><strong>Your workspace is empty</strong><span>Add class PDFs to get started.</span></div>}
            <div className="privacy-note"><LockIcon/><span><b>Private by design</b><br/>Processing happens in this browser. Files aren't uploaded to a server.</span></div>
          </aside>

          <section className="center-column">
            <div className="panel slide-panel">
              <div className="panel-heading"><div><h2>Slide organizer</h2><p>Move slides to set the final reading order.</p></div><span className="count-chip">{slides.length} slides</span></div>
              {slides.length ? <div className="slide-grid">{slides.map((slide, i) => <div className={`slide-card ${activeSlide === slide.id ? "selected" : ""}`} key={slide.id} onClick={() => setActiveSlide(slide.id)}>
                <div className="thumb-wrap"><img src={processedPreviews[slide.id] ?? slide.preview} alt={`Processed preview of ${slide.fileName}, page ${slide.pageNumber}`} loading="lazy"/><span className="slide-index">{i + 1}</span></div>
                <div className="slide-info"><strong>{slide.fileName}</strong><span>Original page {slide.pageNumber}</span><div className="slide-controls"><button onClick={e => {e.stopPropagation();moveSlide(i,-1)}} disabled={i === 0} title="Move slide up">↑</button><button onClick={e => {e.stopPropagation();moveSlide(i,1)}} disabled={i === slides.length-1} title="Move slide down">↓</button><button className="delete-control" onClick={e => {e.stopPropagation();removeSlide(slide.id)}} title="Remove slide">Remove</button></div></div>
              </div>)}</div> : <div className="empty-slides"><div className="empty-art large"><StackIcon/></div><h3>Your slides will appear here</h3><p>Upload one or more PDFs to arrange pages and prepare your notes.</p><button className="button button-primary" onClick={() => inputRef.current?.click()}>＋ Add PDFs</button></div>}
            </div>
            {current && <div className="panel preview-panel"><div className="panel-heading"><div><h2>Slide preview</h2><p>{current.fileName} · page {current.pageNumber}</p></div><span className="preview-tag">PROCESSED</span></div><div className="large-preview"><img src={processedPreviews[current.id] ?? current.preview} alt="Selected slide processed preview"/></div></div>}
            {slides.length > 0 && <div className="panel preview-panel">
              <div className="panel-heading"><div><h2>A4 print preview</h2><p>First output page · 3 slide slots</p></div><span className="preview-tag">A4 PORTRAIT</span></div>
              <div style={{ display: "flex", justifyContent: "center", padding: 16, background: "#eef1f5" }}>
                <div style={{ width: "min(100%, 340px)", aspectRatio: "595.2756 / 841.8898", background: "#fff", boxShadow: "0 2px 12px rgba(0,0,0,.12)", display: "grid", gridTemplateRows: "repeat(3, 1fr)", overflow: "hidden" }}>
                  {[0, 1, 2].map(slot => {
                    const slide = slides[slot];
                    return <div key={slot} style={{ minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", borderBottom: slot < 2 ? "1px dashed #d5d9df" : "none" }}>
                      {slide ? <img src={processedPreviews[slide.id] ?? slide.preview} alt={`Print page slot ${slot + 1}`} style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }} /> : <span style={{ color: "#a0a7b2", fontSize: 12 }}>Empty slot</span>}
                    </div>;
                  })}
                </div>
              </div>
              <p className="hint" style={{ padding: "0 16px 16px" }}>This is a screen preview of the first A4 sheet. Final PDF preserves slide proportions and stacks up to three slides per page.</p>
            </div>}
          </section>

          <aside className="settings-column panel">
            <div className="panel-heading"><div><h2>Print settings</h2><p>Optimized for everyday printers.</p></div><div className="settings-glyph">☷</div></div>
            <div className="setting-section"><label className="setting-label">PAGE LAYOUT</label><div className="paper-card"><div className="paper-illustration"><div/><div/><div/></div><div className="paper-meta"><strong>A4 · Portrait</strong><span>3 slides per page</span><span className="green-text">Zero margins · No borders</span></div><span className="checkmark">✓</span></div><p className="hint">Slides are stacked top-to-bottom. Original proportions are preserved; content is never stretched or cropped.</p></div>
            <div className="setting-section"><label className="setting-label">BACKGROUND CORRECTION</label><div className="option-list">
              <label className={`radio-option ${mode === "auto" ? "chosen" : ""}`}><input type="radio" name="mode" checked={mode === "auto"} onChange={() => setMode("auto")}/><span className="radio-mark"/><span><b>Auto invert dark slides</b><small>Detect dark backgrounds automatically</small></span><span className="recommended">Recommended</span></label>
              <label className={`radio-option ${mode === "all" ? "chosen" : ""}`}><input type="radio" name="mode" checked={mode === "all"} onChange={() => setMode("all")}/><span className="radio-mark"/><span><b>Invert every slide</b><small>Reverse all colours</small></span></label>
              <label className={`radio-option ${mode === "none" ? "chosen" : ""}`}><input type="radio" name="mode" checked={mode === "none"} onChange={() => setMode("none")}/><span className="radio-mark"/><span><b>Keep original background</b><small>No inversion</small></span></label>
            </div></div>
            <div className="setting-section">
              <label className="setting-label">NCERT INK SAVER</label>
              <label className={`radio-option ${inkSaver ? "chosen" : ""}`} style={{ marginBottom: 10 }}>
                <input type="checkbox" checked={inkSaver} onChange={e => setInkSaver(e.target.checked)} />
                <span className="radio-mark"/>
                <span><b>Clean photographed NCERT pages</b><small>Lightens pale page backgrounds while keeping dark text and annotations</small></span>
              </label>
              {inkSaver && <>
                <div className="option-list">
                  <label className={`radio-option ${cleanup === "light" ? "chosen" : ""}`}><input type="radio" name="cleanup" checked={cleanup === "light"} onChange={() => setCleanup("light")}/><span className="radio-mark"/><span><b>Light cleanup</b><small>Preserves more original page colour</small></span></label>
                  <label className={`radio-option ${cleanup === "balanced" ? "chosen" : ""}`}><input type="radio" name="cleanup" checked={cleanup === "balanced"} onChange={() => setCleanup("balanced")}/><span className="radio-mark"/><span><b>Balanced</b><small>Whiter pages with readable text</small></span><span className="recommended">Recommended</span></label>
                  <label className={`radio-option ${cleanup === "strong" ? "chosen" : ""}`}><input type="radio" name="cleanup" checked={cleanup === "strong"} onChange={() => setCleanup("strong")}/><span className="radio-mark"/><span><b>Maximum ink saving</b><small>Reduces more pale background shading</small></span></label>
                </div>
                <div className="threshold">
                  <div><label htmlFor="clarity">Text clarity</label><b>{clarity}%</b></div>
                  <input id="clarity" type="range" min="0" max="100" value={clarity} onChange={e => setClarity(Number(e.target.value))}/>
                </div>
              </>}
              <p className="hint">Auto correction now lightens dark slide backgrounds locally while preserving dark text inside bright NCERT page photos. Grayscale is recommended for cleaner text edges; Pure B&amp;W can make thin lines look heavier.</p>
            </div>
            <div className="setting-section"><label className="setting-label">OUTPUT COLOUR</label><div className="tone-toggle"><button className={tone === "grayscale" ? "selected" : ""} onClick={() => setTone("grayscale")}><span className="tone-swatch gray"/>Grayscale</button><button className={tone === "mono" ? "selected" : ""} onClick={() => setTone("mono")}><span className="tone-swatch mono"/>Pure B&amp;W (may thicken lines)</button></div>{tone === "mono" && <div className="threshold"><div><label htmlFor="threshold">Black/white threshold</label><b>{threshold}</b></div><input id="threshold" type="range" min="100" max="230" value={threshold} onChange={e => setThreshold(Number(e.target.value))}/></div>}</div>
            <div className="setting-section filename-section"><label className="setting-label" htmlFor="filename">OUTPUT FILENAME</label><div className="filename-input"><FileIcon/><input id="filename" value={filename} onChange={e => setFilename(e.target.value)} aria-label="Output filename"/></div></div>
            <div className="export-summary"><div><span>Output pages</span><b>{totalOutputPages}</b></div><div><span>Slides per page</span><b>3</b></div><div><span>Paper size</span><b>A4 portrait</b></div></div>
            <button className="button button-primary export-button" onClick={exportPdf} disabled={!slides.length || busy}><DownloadIcon/>{busy ? "Processing…" : "Export print-ready PDF"}<span>→</span></button>
            <p className="export-footnote"><LockIcon/> Your PDFs stay on this device.</p>
          </aside>
        </div>
        {(busy || progress) && <div className="status-bar"><span className={busy ? "spinner" : "status-check"}>{busy ? "" : "✓"}</span><span>{progress}</span>{busy && <div className="progress-track"><div/></div>}</div>}
        {error && <div className="error-banner"><span>!</span>{error}<button onClick={() => setError("")}>×</button></div>}
        <footer><span>PrintNotes <b>·</b> Made for focused study</span><span><LockIcon/> Local processing · No account needed</span></footer>
      </main>
    </div>
  );
}

function UploadIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>}
function FileIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M14 3.5v5h4M8 13h8M8 16h8"/></svg>}
function StackIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/></svg>}
function LockIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>}
function DownloadIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 17v3h16v-3"/></svg>}
