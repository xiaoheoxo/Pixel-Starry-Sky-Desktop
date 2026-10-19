// Vite 的 ?raw 导入：把文件内容作为字符串打进主进程（app/splash.ts 的开机画面页面）
declare module '*?raw' {
  const content: string
  export default content
}
