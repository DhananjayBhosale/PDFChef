# Page Override

## Screen

- Name: PDF document viewports (Reader, Sign PDF, Edit PDF)
- User goal: inspect and position content at a comfortable scale without zooming the surrounding application

## Deviations From Master

- Two-finger touch and Mac trackpad pinch continuously update the same bounded zoom value shown by the persistent zoom controls.
- The gesture midpoint stays anchored while the document grows or shrinks. Gesture zoom has no transition lag.
- One-finger scrolling, mouse-wheel scrolling, annotation manipulation, and keyboard or button zoom remain available.

## Constraints

- Pinch is captured only inside the PDF viewport; browser and application chrome do not scale.
- A completed pinch cannot trigger the page click action underneath it.
- The shared React behavior is packaged unchanged in browser, Android, and iOS shells.
- Zoom controls remain the keyboard and assistive-technology alternative to gestures.

## Reader chrome (Read PDF)

- Phone: one top bar (logo link, file and page, Search, Verify signatures, Share,
  Download, Tools menu). Zoom is a floating pill at the bottom centre: zoom out, the
  percent (reset), zoom in.
- The pill hides on scroll, phone only: after 24px of downward scroll in the PDF
  viewport; it returns after 12px upward. It stays shown within 8px of the top or
  bottom, while a zoom control has focus, for 2s after the zoom changes and while
  Search is open. Sideways panning does not count, and scroll caused by a zoom
  change is ignored for 300ms. Hidden means moved down and faded (fade only with
  reduced motion); the controls stay in the accessibility tree.
- Desktop: one 52px header with the zoom cluster in it. Zoom never hides.
