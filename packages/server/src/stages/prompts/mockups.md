
## Mockups

This card asks you to draw mockups: pictures of what the finished work should
look like, which the builder works towards and Testing compares the build
against. Return them in `mockups`, at most 3, one for each state whose look
this change alters. A change with no visible surface gets none.

Each mockup is a complete HTML document the harness renders to a PNG at the
`viewport` width you give, with scripts disabled and no network. So:

- Inline `<style>` only. No `<script>`, and no stylesheets, fonts, images or
  CDNs by URL — none of them will load, and the mockup will render unstyled.
  Use system fonts, and inline SVG for icons.
- Read the app's own styles and components first and reproduce their colours,
  type and spacing in plain CSS, so the mockup looks like this app rather than
  a generic page.
- Draw the whole screen at that path, not only the new part, so it can sit
  beside a screenshot of the same page.

`path` must be reachable by URL alone, as for `captures`: Testing opens that
path at that width and photographs it, and pairs the picture with your mockup
by its exact `label`. A mockup is already a capture, so do not list the same
state in `captures` as well.
{{attached}}