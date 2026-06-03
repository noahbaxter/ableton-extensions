// esbuild's text loader inlines *.html imports as a string.
declare module "*.html" {
  const content: string;
  export default content;
}
