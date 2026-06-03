# Amazon Search Toolkit (Chrome Extension)

Enhances Amazon search listings with:

- **Deliver by date** filtering (latest acceptable delivery date)
- **Price range** filtering (min/max)
- **Sponsored result cleanup**
- **Inline sorting** (delivery date, review count)
- **Grid view toggle** (4 items per row)
- **Multi-page loading** from the results toolbar

## What it does

On Amazon search pages (`/s`), the extension injects an inline toolbar to help you clean up and organize results. It can filter cards by delivery date, hide sponsored blocks, sort product cards, and switch the results list into a continuous 4-column grid view.

## Install in Chrome (macOS)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select this folder:
   - `path/to/amazon`
5. Pin the extension from the puzzle icon if you want quick access.

## Use it

1. Visit an Amazon search results page (example: `https://www.amazon.com/s?k=jeans`).
2. The inline toolbar appears at the top of results automatically with controls for:
   - **Pages**: Enter how many result pages to load (1–50)
   - **Deliver-by date**: Pick a cutoff date for delivery filtering
   - **Price**: Set minimum and/or maximum product price
   - **Include unknown**: Toggle to include/exclude items with no delivery estimate
   - **Apply / Reset**: Apply filters or reset to default view
   - **Sort buttons**: Reorder by delivery date, review count, or reset to original order
   - **Grid View**: Toggle between list and 4-column grid layout
3. Click **Apply** after changing delivery filter inputs.

Changes are saved and auto-apply when results update.

## Notes

- Amazon changes markup frequently, so selectors may need occasional updates.
- Date parsing supports common English date labels and formats (`Today`, `Tomorrow`, `May 14`, `May 14 - May 16`).
- Unknown delivery dates can be included/excluded with the checkbox.

## Support

If this toolkit helps you, you can support development here:

- https://buymeacoffee.com/kevinatruong
