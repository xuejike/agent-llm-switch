// @iarna/toml 的最小类型声明
//
// 该库（@iarna/toml@2.x）未自带 TypeScript 类型声明，这里补一份最小声明，
// 仅覆盖本项目 render 引擎所需的 parse / stringify 两个 API。
// 若后续需要更完整的 TOML 能力，可在此扩展或改用带类型的发行版。

declare module "@iarna/toml" {
  /** 把 TOML 文本解析为 JS 对象 */
  export function parse(input: string): Record<string, unknown>;
  /** 把 JS 对象序列化为 TOML 文本 */
  export function stringify(obj: Record<string, unknown>): string;
}
