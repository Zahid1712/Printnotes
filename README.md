# PrintNotes

PrintNotes is a browser-based PDF utility for turning lecture slides into printer-friendly A4 notes. PDF files are processed locally in your browser; they are not sent to a PrintNotes server.

## Features

- Add multiple PDFs in one batch, then add more.
- View each source file and its page count.
- Reorder whole files and individual slides using Move up / Move down controls.
- Remove individual slides or whole PDFs.
- Choose automatic dark-slide inversion, invert all, or no inversion.
- Grayscale or high-contrast monochrome output.
- Preview rendered slides and download a combined PDF.
- A4 portrait output with 3 vertically stacked slide areas, zero page margins, no borders and no gaps.
- Preserves slide aspect ratio. Slides are contained inside each third of the page; if their aspect ratio differs from the slot, white unused space may remain. The content is never stretched or cropped.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Build

```bash
npm run build
npm run preview
```

## Deploy to Netlify

1. Create a new Git repository and add these project files.
2. Push the repository to GitHub/GitLab/Bitbucket.
3. In Netlify, choose **Add new site → Import an existing project**.
4. Select the repository. Netlify should detect the included `netlify.toml`.
5. Build command: `npm run build`; publish directory: `dist`.
6. Deploy.

You can also run `npm run build` locally and deploy the `dist` directory using Netlify Drop.

## Notes and limitations

- This is a client-side app. Large PDFs can use substantial browser memory, especially on iPads. Try smaller batches if a browser tab runs out of memory.
- Automatic inversion uses a visual estimate based on average slide brightness. It is useful for many dark lecture slides but may need manual mode changes for unusual slides.
- The app rasterizes slides during export so that inversion and monochrome processing are applied consistently. Rasterized PDFs may not have selectable text; use a high render scale for better print clarity.
- Password-protected or malformed PDFs may fail to load.
- Three slides per A4 page can make small slide text hard to read. Review the preview before printing.
- No user accounts, analytics, or upload server are included.
