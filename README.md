# BOBOCloud Notebook Preview

Install **Notebook Preview** in Extensions → Marketplace on BOBOCloud 2.8.1, enable it, then open an `.ipynb` file in the workspace. You can also import the package from [Releases](https://github.com/NemophilistJohn/BOBOCloud-Jupter-support/releases).

- Preview format 4 notebook code, Markdown, TeX math, saved text and tracebacks, raster images, and static tables.
- Jump to a cell from the outline, collapse cells and outputs, or filter by source and saved text. The toolbar expands or collapses the current page.
- **Original JSON** shows the unchanged file, including unknown fields and metadata. Large files are shown in pages.
- The plugin reads only the file you opened. It does not execute code, write files, fetch external resources, or render widgets, scripts, or SVG.

The Notebook activity item shows the supported file type. Open files from the workspace explorer; use the document outline to navigate cells. This plugin takes precedence over the general Document Preview for `.ipynb` files.

The Notebook activity item uses its own book icon on Plugin API 1.7.0 and later. On older clients it uses the default host icon. Markdown and code cells use matching color markers in the cell header and outline.

The 24 MiB file limit applies to both views. Each preview text block is limited to 32,000 characters, each cell to 24 rendered outputs, and each image to 8 MiB of base64.

## Development

Run `npm ci`, `npm run verify`, and `npm run test:ui`. Set `BOBOCLOUD_HOST_CLIENT` to the BOBOCloud 2.8.1 client with its dependencies and dev renderer built, if it isn't in the sibling `my-electron-app/client` directory. Set `BOBOCLOUD_GENERAL_PREVIEW_ARTIFACT` to the Document Preview 1.1.1 archive if it isn't available in its sibling repository.

The tag workflow verifies the committed archive against a fresh build, tests it through Electron, then publishes that archive. The package contains third-party notices.
