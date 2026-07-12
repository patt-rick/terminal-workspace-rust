/** Distro named in a \\wsl$\<distro>\… or \\wsl.localhost\<distro>\… path. */
export function distroOfUncPath(path: string): string | null {
  const m = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\/]+)/i.exec(path)
  return m ? m[1] : null
}
