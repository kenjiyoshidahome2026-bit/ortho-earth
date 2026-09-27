// `node --import @ortho-earth/tile-formats/node-register script.mjs` ＝ node-hook.mjs を module.register で載せるだけの入口
import { register } from "node:module";
register("./node-hook.mjs", import.meta.url);
