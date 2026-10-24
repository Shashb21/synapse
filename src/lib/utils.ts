import { createCn } from "cn/config"

/**
 * Class merging that knows the type scale in globals.css (KAN-158). Without it,
 * `text-callout` reads as a text colour and drops e.g. `text-primary-foreground`.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["caption", "callout", "body", "headline", "title-2", "title-1", "display"] }],
    },
  },
})
