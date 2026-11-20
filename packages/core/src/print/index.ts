// `@parser-kit/core/print`: a document IR and a width-aware renderer for
// turning ASTs back into text. A separate entry point, so parse-only users
// never load it.
import * as doc from "./doc";

export {
  type BlockOptions,
  block,
  type Doc,
  type DocCommand,
  type Group,
  type GroupOptions,
  group,
  hardline,
  type IfBreak,
  type Indent,
  ifBreak,
  indent,
  join,
  type Line,
  type ListOptions,
  line,
  list,
  nbsp,
  softline,
} from "./doc";
export { type RenderOptions, render } from "./render";
export { doc };
