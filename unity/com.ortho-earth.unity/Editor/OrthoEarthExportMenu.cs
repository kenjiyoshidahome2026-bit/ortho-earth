// Ortho Earth > Export selection to GLB…  (Unity → ortho-earth, docs/notes/unity-roundtrip.md §4)
//   Exports the selected GameObjects with glTFast's exporter, then stamps asset.extras.orthoEarth = { anchor, frame: "enu", heading } into the GLB,
//   taken from the nearest OrthoEarthAnchor above the selection (or the first one in the scene). ortho-earth places such a GLB at the anchor
//   when you drop it on the globe (map.gadget.model), and glbconv folds the anchor into CESIUM_RTC for 3D Tiles.
//   glTFast cannot write asset.extras itself, so the JSON chunk of the GLB is patched here (dependency-free, ~30 lines).
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using GLTFast.Export;
using Unity.Mathematics;
using UnityEditor;
using UnityEngine;

namespace OrthoEarth.Editor
{
	public static class OrthoEarthExportMenu
	{
		const string Generator = "ortho-earth unity 0.1";

		[MenuItem("Ortho Earth/Export selection to GLB…", validate = true)]
		static bool Validate() => Selection.gameObjects.Length > 0;

		[MenuItem("Ortho Earth/Export selection to GLB…")]
		public static async void Export()
		{
			var sel = Selection.gameObjects;
			var anchor = sel.Select(g => g.GetComponentInParent<OrthoEarthAnchor>()).FirstOrDefault(a => a != null) ?? UnityEngine.Object.FindFirstObjectByType<OrthoEarthAnchor>();
			if (anchor == null) { EditorUtility.DisplayDialog("Ortho Earth", "No OrthoEarthAnchor in the scene. Add one (Ortho Earth/Anchor) on a parent of the model and set lon/lat/height.", "OK"); return; }
			var path = EditorUtility.SaveFilePanel("Export GLB for ortho-earth", "", sel[0].name + ".glb", "glb");
			if (string.IsNullOrEmpty(path)) return;
			await ExportTo(sel, anchor, path);
		}

		public static async Task<bool> ExportTo(GameObject[] objects, OrthoEarthAnchor anchor, string path)
		{
			var export = new GameObjectExport(new ExportSettings { Format = GltfFormat.Binary, FileConflictResolution = FileConflictResolution.Overwrite }, new GameObjectExportSettings { OnlyActiveInHierarchy = true });
			// Export in the anchor's space: glTFast writes world transforms, so objects placed under the anchor keep their local metres.
			export.AddScene(objects, (float4x4)anchor.transform.worldToLocalMatrix, anchor.gameObject.name);
			var tmp = path + ".tmp";
			if (!await export.SaveToFileAndDispose(tmp)) { Debug.LogError("[Ortho Earth] glTFast export failed"); return false; }
			var glb = File.ReadAllBytes(tmp); File.Delete(tmp);
			var extras = JsonUtility.ToJson(AnchorJson.FromAnchor(anchor, Generator));
			File.WriteAllBytes(path, StampExtras(glb, extras));
			Debug.Log($"[Ortho Earth] wrote {path} with anchor {anchor.lon}, {anchor.lat}, h {anchor.height} m, heading {anchor.heading}°. Drop it on www.ortho-earth.com/japan/ (?g=) or convert with glbconv.");
			return true;
		}

		/// <summary>Insert "extras":{"orthoEarth":…} into the asset object of a GLB's JSON chunk and fix the chunk/total lengths.</summary>
		public static byte[] StampExtras(byte[] glb, string orthoEarthJson)
		{
			if (glb.Length < 20 || BitConverter.ToUInt32(glb, 0) != 0x46546C67) throw new InvalidDataException("not a GLB");
			int jsonLen = (int)BitConverter.ToUInt32(glb, 12);
			if (BitConverter.ToUInt32(glb, 16) != 0x4E4F534A) throw new InvalidDataException("first chunk is not JSON");
			var json = Encoding.UTF8.GetString(glb, 20, jsonLen).TrimEnd(' ', '\0');
			int a = json.IndexOf("\"asset\":{", StringComparison.Ordinal);
			if (a < 0) throw new InvalidDataException("GLB without asset");
			int ins = a + "\"asset\":{".Length;
			// an existing asset.extras is merged by nesting ours first: {"extras":{"orthoEarth":…},…} — glTFast does not write extras, so this is the usual path
			var patched = json.Substring(0, ins) + "\"extras\":{\"orthoEarth\":" + orthoEarthJson + "}," + json.Substring(ins);
			if (patched.Contains("\"extras\":{\"orthoEarth\":" + orthoEarthJson + "},\"extras\":")) patched = patched.Replace("},\"extras\":{", ",");   // merge with an existing extras object
			var jb = Encoding.UTF8.GetBytes(patched);
			int pad = (4 - jb.Length % 4) % 4;
			var rest = new byte[glb.Length - 20 - jsonLen]; Array.Copy(glb, 20 + jsonLen, rest, 0, rest.Length);
			var outp = new byte[20 + jb.Length + pad + rest.Length];
			Array.Copy(glb, 0, outp, 0, 12);
			BitConverter.GetBytes((uint)outp.Length).CopyTo(outp, 8);
			BitConverter.GetBytes((uint)(jb.Length + pad)).CopyTo(outp, 12);
			BitConverter.GetBytes(0x4E4F534Au).CopyTo(outp, 16);
			jb.CopyTo(outp, 20); for (int i = 0; i < pad; i++) outp[20 + jb.Length + i] = 0x20;
			rest.CopyTo(outp, 20 + jb.Length + pad);
			return outp;
		}
	}
}
