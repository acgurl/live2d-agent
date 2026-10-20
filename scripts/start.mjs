import { spawn } from "node:child_process";
import path from "node:path";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electron = process.platform === "win32"
  ? path.join(process.cwd(), "node_modules", "electron", "dist", "electron.exe")
  : path.join(process.cwd(), "node_modules", ".bin", "electron");

const child = spawn(electron, ["."], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
