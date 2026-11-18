# BOBOCloud Notebook Preview

Install **Notebook Preview** in Extensions → Marketplace, enable it, then open an `.ipynb` file in the workspace. Version 1.1 needs BOBOCloud 2.8.1 with Plugin API 1.8 or later. You can also import the package from [Releases](https://github.com/NemophilistJohn/BOBOCloud-Jupter-support/releases); older hosts can use version 1.0.2.

- Preview format 4 notebook code with offline syntax highlighting, Markdown, TeX math, saved text and tracebacks, raster images, and static tables.
- Jump to a cell from the outline, collapse cells and outputs, or filter by source and saved text. The toolbar expands or collapses the current page.
- Use the cell toolbar to edit or move one cell at a time. Save with the toolbar or Ctrl/Cmd+S. The host checks for external changes before writing. A conflict leaves the draft open.
- **Original JSON** shows the last loaded or saved version, including unknown metadata and outputs. Saving changes only cell source and order. Large files are shown in pages.
- Python completion (Ctrl+Space or after a dot) and diagnostics use the configured remote analyzer when enabled. The editor analyzes code cells together in notebook order. IPython magic and shell escapes are skipped.
- The plugin does not execute code, load external preview resources, or render widgets, scripts, or SVG.

The Notebook activity item shows the supported file type. Open files from the workspace explorer; use the document outline to navigate cells. This plugin takes precedence over the general Document Preview for `.ipynb` files.

The Notebook activity item uses a book icon. Markdown and code cells use matching color markers in the cell header and outline.

The 24 MiB file limit applies to both views. Each preview text block is limited to 32,000 characters, each cell to 24 rendered outputs, and each image to 8 MiB of base64.

## Development

Run `npm ci`, `npm run verify`, and `npm run test:ui`. Set `BOBOCLOUD_HOST_CLIENT` to the BOBOCloud 2.8.1 client with its dependencies and dev renderer built, if it isn't in the sibling `my-electron-app/client` directory. Set `BOBOCLOUD_GENERAL_PREVIEW_ARTIFACT` to the Document Preview 1.1.1 archive if it isn't available in its sibling repository.

The tag workflow verifies the committed archive against a fresh build, tests it through Electron, then publishes that archive. The package contains third-party notices.
