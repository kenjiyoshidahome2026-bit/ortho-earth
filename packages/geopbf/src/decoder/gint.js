import { unPackGintBuffer } from "../extension/topology.js";
onmessage = ({ data: { sab } }) => { postMessage(unPackGintBuffer(sab)); };
