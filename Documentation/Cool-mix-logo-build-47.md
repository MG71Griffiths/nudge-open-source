# Cool Mix logo — build 47

The user selected **04 / Cool Mix** from their supplied three-leaf colour exploration sheet: cobalt left leaf and lower stem, purple upper leaf, and teal right leaf. This replaces the former sprout brand mark and mascot app icon. The separate in-app character artwork is unchanged.

The accepted master was produced with the built-in `image_gen` image-editing tool using that sheet as its reference. The prompt requested only the selected mark, preserving its silhouette, orientation, three discrete colour regions and negative-space veins, with no text, other marks, background texture or new decoration. This is generated artwork based on the supplied reference, not a claim of pixel-identical extraction. The complete accepted prompt and generation evidence are retained privately under `.local/logo-targets-build-47/logo/`.

The same transparent 1254 × 1254 PNG master is shipped byte-for-byte at:

- `Nudge/Assets.xcassets/NudgeMark.imageset/NudgeMark.png`
- `Web/assets/nudge-logo.png`

Its SHA-256 is `965e0b8bfb9b73256916c4d6db3e83329cb9d187978866658802ed19ac187974`.

The native main and Search headers, onboarding title and Web header use that original-colour mark. Existing accessible navigation labels remain; the decorative mark does not create another VoiceOver stop. Existing semantic control and nutrition colours are independent of the mark.

Native CoreGraphics packaging fits the complete master canvas within a uniform 12% inset on opaque white, without retouching, recolouring or redrawing it. The resulting app icon is 1024 × 1024 with no alpha. The Web icons use the same packaging at 192 × 192 and 512 × 512. The native universal `AppIcon` asset supplies both the phone icon and the icon associated with a newly uploaded App Store build; it does not change an older submission already in review.

Verification passed: Swift parsing of changed native views, the bundled-resource regression check, asset-catalog compilation, and compiled `AppIcon`/`NudgeMark` name, size and opacity inspection. Static native image previews at 24/34-point mark sizes and 60/120-point icon sizes were visually checked on white and the Nudge canvas. The tool's black transparency preview exaggerated nearly transparent coloured pixels; native white and cream compositing rendered clean edges and veins. No manual cleanup was applied. Static asset checks do not establish physical-phone icon refresh or complete live UI layout; signed-build and device evidence belongs to the release handover.
