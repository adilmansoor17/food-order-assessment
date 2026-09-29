---
version: alpha
name: "Namak Kitchen — Counter Ticket No. 01"
description: "The built visual system for a fictional food-ordering assessment demo."
colors:
  action-red: "#b43d31"
  action-red-deep: "#8f2e27"
  stamp-blue: "#2d5d86"
  field-paper: "#f4eee4"
  ticket-stock: "#fbf7ef"
  charcoal-ink: "#24221e"
  muted-ink: "#625d54"
  registration-rule: "#bcb4a7"
  pale-stock: "#eae1d4"
  white: "white"
typography:
  display:
    fontFamily: "Anton, Impact, sans-serif"
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: "-0.025em"
  section-title:
    fontFamily: "Anton, Impact, sans-serif"
    fontSize: "1.65rem"
    fontWeight: 400
    lineHeight: 1.2
  body:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.45
  button:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 700
  ticket-label:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "0.61rem"
    fontWeight: 800
    letterSpacing: "0.15em"
rounded:
  control: "2px"
spacing:
  ticket-gap: "13px"
  panel-gap: "22px"
  desktop-gutter: "36px"
  tablet-gutter: "20px"
  mobile-gutter: "16px"
components:
  button-primary:
    backgroundColor: "{colors.action-red}"
    textColor: "{colors.white}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
  button-primary-hover:
    backgroundColor: "{colors.action-red-deep}"
  button-ink:
    backgroundColor: "{colors.charcoal-ink}"
    textColor: "{colors.white}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.charcoal-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
  filter-selected:
    backgroundColor: "{colors.action-red}"
    textColor: "{colors.white}"
  ticket-card:
    backgroundColor: "{colors.ticket-stock}"
    textColor: "{colors.charcoal-ink}"
  paper-panel:
    backgroundColor: "{colors.ticket-stock}"
    textColor: "{colors.charcoal-ink}"
    padding: "23px"
  status-stamp:
    textColor: "{colors.stamp-blue}"
---

# Design System: Counter Ticket No. 01

## Overview

**Creative North Star: "Counter Ticket No. 01"**

The interface borrows the useful parts of a fast-casual counter ticket: a large dish image, a visible variant choice, a legible price, and a numbered order record. Uncoated paper, condensed ink headlines, fine registration rules, and a blue stamp make the journey feel tactile. The ordering controls stay straightforward and readable.

This is the current visual identity of a fictional assessment demo. “Namak Kitchen” and its menu imagery are synthetic presentation choices, not a confirmed merchant brand. The menu, cart, order, account, and admin routes share the paper and ink language; live catalog, stock, price, payment, and order states come from the API.

**Key Characteristics:**

- Photo-led dish tickets beside a persistent order docket at wide widths.
- Warm paper and charcoal ink, with red for actions and blue for status and focus.
- Condensed display headlines over clean sans-serif controls and tabular prices.
- Clear loading, empty, unavailable, and error states that keep their place in the layout.

## Colors

The palette makes the paper the field, ink the content, red the next action, and blue a narrow status signal. Frontmatter holds the exact reusable values.

### Primary

- **Counter Red** (`action-red`): selected filters, primary order actions, the active navigation mark, and current stage.
- **Deep Counter Red** (`action-red-deep`): primary action hover and some error or text-link treatments.

### Secondary

- **Status Stamp Blue** (`stamp-blue`): the docket stamp, focus outline, text selection, and the fixed notice surface.

### Neutral

- **Field Paper** (`field-paper`): page background and the negative space between tickets.
- **Ticket Stock** (`ticket-stock`): menu tickets, docket, and route panels.
- **Charcoal Ink** (`charcoal-ink`): main text, headings, firm rules, and the ink button.
- **Muted Ink** (`muted-ink`): support copy, metadata, and secondary descriptions.
- **Registration Rule** (`registration-rule`): quiet borders and dashed separators.
- **Pale Stock** (`pale-stock`): loading placeholders and subtle utility surfaces.
- **White** (`white`): lettering on solid action and notice surfaces.

**The Two Marks Rule.** Red marks an action or current choice; blue marks status, feedback, or keyboard focus. Neither should become a broad background wash.

## Typography

**Display font:** Anton, loaded in the root layout, with Impact and sans-serif fallbacks. **Body and control font:** Arial with Helvetica and sans-serif fallbacks. Prices and counts use tabular numerals from the current font, not a separate monospace face.

**Character:** The compressed display face gives the interface its printed-ticket voice. The plain sans-serif keeps variants, forms, admin data, and status messages quick to read.

### Hierarchy

- **Display:** Large menu and route headings use a fluid `clamp(3rem, 6.4vw, 6rem)`, regular Anton, tight line height, and slightly negative tracking. The mobile menu heading resolves to `3.4rem` at the narrow breakpoint.
- **Headline:** Ticket names use `clamp(1.24rem, 1.7vw, 1.72rem)` and the same condensed face; at the narrow breakpoint they become `1.9rem` with natural height.
- **Title:** Section headings use regular Anton (`1.65rem`, `1.2` line height).
- **Body:** General text uses Arial (`1rem`, `1.45` line height); compact descriptions and record rows step down locally where the information density requires it.
- **Label:** Buttons use bold Arial (`0.85rem`). Ticket registration labels use extra-bold Arial (`0.61rem`, `0.15em` tracking) and uppercase text.

**The Solid Controls Rule.** Ink texture is clipped to large display letters only; controls, prices, and small labels keep solid readable glyphs.

## Layout

The outer frame caps at `1512px`. At wide widths it uses `36px` side gutters and an `88px` minimum masthead. The menu grid gives the ticket area the flexible majority and the docket `28%` with a `300px` minimum, separated by `23px`. Three tickets sit across the menu area with `13px` gaps. The docket sticks near the top while the menu scrolls.

At `1250px` and below, the ticket grid becomes two columns and the docket fixes at `300px`. At `900px` and below, the menu and interior page grids become one column, the menu docket hides, and a sticky bottom cart link provides the persistent order entry. The cart route shows the full item review and checkout panel. At `620px` and below, use `16px` frame gutters, one ticket column, stacked form pairs, and a horizontally scrollable navigation row. Account, cart, orders, and admin pages reuse the same paper panels and collapse their two-column layouts at `900px`.

**The Visible Choice Rule.** A dish image, available variant, price, and add action belong together on each ticket; the order entry stays reachable when the desktop docket is hidden.

## Elevation & Depth

Depth comes mainly from contrasting paper tones, fine ink rules, the paper-stock SVG fleck texture, and a very light shadow. The shared ticket, docket, and panel shadow is `1px 6px 16px rgba(64, 45, 25, .09)`. The fixed notice uses `3px 7px 18px rgba(25, 39, 49, .22)` so it clears the page. The mobile cart link uses an upward `0 -4px 14px rgba(40, 30, 20, .14)` shadow. Large display letters also have a clipped ink-print SVG texture when the browser supports text clipping.

**The Paper First Rule.** Use tonal stock and rule lines for hierarchy; keep shadows low enough that tickets still read as paper rather than floating tiles.

## Shapes

Panels and tickets are rectangular. Buttons and form fields use a small `2px` radius; tabs and search borders remain square. Menu tickets and the docket use repeated circular cutouts along their top and bottom edges, with dashed rules and small registration labels inside. Radios, stage nodes, and the cart-count badge are circular because they represent selection or count, not because the overall interface is rounded.

## Components

### Buttons

The shared button has a `43px` minimum height, `11px 17px` padding, bold compact text, and a `2px` radius. Primary buttons use Counter Red with white type and deepen on hover. Ink buttons support retry and secondary confirmation. Outline buttons keep a quiet border that becomes red on hover. All shared button color and border transitions take `.16s ease`; disabled controls retain their place and lower opacity. Keyboard focus uses a visible blue `3px` outline with offset.

### Filters and variants

Category and auth tabs are square, bordered selectors; the selected tab fills red with white type. Menu variants are semantic radios with a circular ink outline and a red checked state. The row keeps the variant name and tabular PKR price aligned; unavailable options remain visible and disabled.

### Cards and panels

A menu ticket is a photographic rectangle above a numbered category register, condensed dish title, short description, variant list, full-width add button, and small footer. Its image has a text fallback when photography is absent or fails. The docket repeats the same ticket stock and perforation, with a blue count/status stamp, aligned rows, estimated total, primary review action, and a plain-language Choose–Review–Place guide. Interior routes use simpler paper panels with firm section headers and dashed item dividers.

### Inputs and feedback

Search is a square outlined field with an inline SVG magnifier. Account, bank-reference, and admin fields use light fill, thin warm border, and a `2px` radius. Search and form fields show a blue `3px` focus treatment. Errors stay adjacent to the affected content. Loading skeletons and empty or retry panels preserve space; one fixed notice region carries successful feedback without moving the page.

### Navigation and status

The masthead holds the wordmark, explicit assessment label, route links, cart count, and account action. The active route is red with a short underline. The admin link appears only for an admin user, while server permission remains authoritative. Order state is printed as compact status pills with separate good, bad, and pending tones, and the docket stamp stays blue. Prices and counts align with tabular numerals.

### Motion

The docket stamp settles once with a `.32s` `cubic-bezier(.16, 1, .3, 1)` rotation and scale. Shared button state changes use `.16s ease`. Under `prefers-reduced-motion: reduce`, the stamp animation is removed and transition and animation durations reduce to `.01ms`.

## Do's and Don'ts

### Do:

- **Do** keep product imagery, variant controls, price, and add action together on a ticket.
- **Do** use blue focus and status marks, red selection and action marks, and tabular numerals for money.
- **Do** make loading, unavailable, failure, and empty states legible within the same paper layout.
- **Do** treat the current name, photos, and menu as synthetic assessment content.

### Don't:

- **Don't** spread the ink texture onto small controls or prices.
- **Don't** replace thin rules and perforation with large rounded card shapes or heavy elevation.
- **Don't** hide unavailable variants or imply a payment or fulfillment state before the API confirms it.
- **Don't** add restaurant claims, reviews, timings, or merchant details that the product brief does not establish.
