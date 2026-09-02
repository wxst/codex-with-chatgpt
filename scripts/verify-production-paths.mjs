import fs from "node:fs";
import path from "node:path";

export function isLocalAbsolutePath(value, platform = process.platform) {
  if (platform === "win32") {
    return path.win32.isAbsolute(value) && /^[A-Za-z]:[\\/]/.test(value);
  }
  return path.posix.isAbsolute(value) && !value.startsWith("//");
}

export function localRegularFile(
  value,
  label,
  {
    platform = process.platform,
    lstatSync = fs.lstatSync,
    realpathNativeSync = fs.realpathSync.native,
  } = {}
) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} path missing`);
  if (!isLocalAbsolutePath(value, platform)) throw new Error(`${label} path unsafe`);

  const stat = lstatSync(value);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);

  const realPath = realpathNativeSync(value);
  if (!isLocalAbsolutePath(realPath, platform)) throw new Error(`${label} resolved path unsafe`);
  return realPath;
}
