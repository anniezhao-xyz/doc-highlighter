# Doc Highlighter

Upload a PDF or image, type the words or phrases to highlight, and export a marker-swipe animation:

- **MP4**: a finished H.264 video at 1:1 (1920×1920), 16:9 (HD or 4K) or 9:16.
- **Premiere package (.zip)**: the page and each highlight as separate layers in an XML sequence. Each swipe is a pair of Crop keyframes, so editors can retime it in Premiere. Unzip it and use File › Import on the `.xml` inside. See the `README.txt` in the zip for details.
- **After Effects package (.zip)**: a `.jsx` script plus the full-resolution page. Run it with File › Scripts › Run Script File… to build a comp with a background solid, the page layer, and one shape layer per highlight. The highlights are parented to the page, and each swipe is two Scale keyframes with the same ease-out as the preview.

In Preview, drag to reposition the shot and use the Zoom slider (or scroll) to frame it, or type an exact Position X/Y and Scale (these match the Page layer in After Effects). All three exports use that framing.

Other options:
- **Blend mode**: Auto picks Multiply for light pages and Screen for dark-mode pages (light text on dark). You can also set Multiply, Screen or Normal yourself.
- **Longer phrases take longer to swipe**: the swipe moves at a steady speed. The Swipe length slider sets the time for a phrase of about 80 characters.
- **Fixing where a highlight ends**: in Edit view, click a highlight, then drag its blue end handle or press ← / → (Shift for bigger steps). These fixes are kept when you re-run Find.
- **Highlight motion**: posterize the swipe to 12 or 8 fps for a stepped, hand-animated feel. The video itself can also be exported at 12 fps.

To change the preset marker colors, edit `SWATCHES` at the top of `app.js`.

## Running it

Everything runs in the browser and no files are uploaded anywhere. To run it locally, serve it over http rather than opening it as a file, because it loads libraries:

```bash
cd ~/Desktop/doc-highlighter && python3 -m http.server 8765
```

Then open http://localhost:8765 in Chrome, Edge or Safari.

## How it finds words

- **PDFs with real text** use the text layer that's already in the file (fast and exact).
- **Images and scanned PDFs** use OCR (Tesseract). The first run downloads about 10 MB of language data.
  Tick "Treat PDF as a scan" if a PDF's text layer is missing or garbled.
- Anything missed can be added by dragging across it in **Edit** view, and it snaps to the words.

## Files

- `index.html`, `style.css`, `app.js`: the whole app
