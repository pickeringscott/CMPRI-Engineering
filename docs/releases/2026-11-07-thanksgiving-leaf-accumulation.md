# Thanksgiving leaf accumulation and greeting placement

- Retains grounded leaves while the configured 96 falling leaves continue animating. Each existing leaf layer keeps up to 300 grounded leaves, preserving layers 1 and 6 and a bounded total of 696 leaf elements.
- Raises the pile height from the previous 80-pixel cap to 100 pixels at the desktop/mobile reference sizes, with proportional limits on shorter viewports. Grounded leaves retain their positions between falling cycles; they are repositioned for viewport or leaf-size changes.
- Docks the desktop greeting at the right edge, leaving a 24-pixel reference margin and at least 20 pixels below the header. Header expansion updates only the greeting's clearance. The turkey, pumpkins and viewport origin retain their approved positions. The mobile greeting retains its approved placement.
- Regenerates content-hashed assets and the worker manifest so returning clients obtain the changed scripts and layouts while reusing unchanged artwork.

Validation: nine animation/cache unit tests; desktop/mobile browser checks for persistent piles, unchanged layer order, expanded-header clearance and window closure; persistent-cache/offline/restart/update browser checks; location editing and scrollbar/background regression checks; ESLint; production build and PDF runtime packaging checks.

No database migration or environment-variable change is required.
