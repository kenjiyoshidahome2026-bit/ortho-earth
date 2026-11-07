// Ortho Earth > Place export folder in scene…
//   Pick a folder written by ortho-export that you copied under Assets/ (e.g. Assets/OrthoEarth/marunouchi/). glTFast's importer has already turned
//   each .glb into a prefab; this puts them all under one GameObject carrying OrthoEarthAnchor (from anchor.json), at identity, and loads .ply point clouds.
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OrthoEarth.Editor
{
	public static class OrthoEarthPlaceMenu
	{
		[MenuItem("Ortho Earth/Place export folder in scene…")]
		public static void Place()
		{
			var abs = EditorUtility.OpenFolderPanel("ortho-export folder (inside Assets/)", Application.dataPath, "");
			if (string.IsNullOrEmpty(abs)) return;
			var proj = Path.GetDirectoryName(Application.dataPath).Replace('\\', '/');
			abs = abs.Replace('\\', '/');
			if (!abs.StartsWith(proj + "/Assets")) { EditorUtility.DisplayDialog("Ortho Earth", "Copy the export folder under Assets/ first, so glTFast can import the GLBs.", "OK"); return; }
			var rel = abs.Substring(proj.Length + 1);   // "Assets/…"
			var anchorPath = Path.Combine(abs, "anchor.json");
			if (!File.Exists(anchorPath)) { EditorUtility.DisplayDialog("Ortho Earth", "anchor.json not found in " + rel, "OK"); return; }
			var json = JsonUtility.FromJson<AnchorJson>(File.ReadAllText(anchorPath));

			var root = new GameObject(Path.GetFileName(abs));
			Undo.RegisterCreatedObjectUndo(root, "Place ortho-export folder");
			var anchor = root.AddComponent<OrthoEarthAnchor>();
			anchor.Apply(json);

			int n = 0;
			foreach (var f in Directory.GetFiles(abs))
			{
				var ext = Path.GetExtension(f).ToLowerInvariant();
				var assetPath = rel + "/" + Path.GetFileName(f);
				if (ext == ".glb" || ext == ".gltf")
				{
					var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
					if (prefab == null) { Debug.LogWarning($"[Ortho Earth] {assetPath}: not imported yet (is glTFast installed?)"); continue; }
					var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab, root.transform);
					go.transform.localPosition = Vector3.zero; go.transform.localRotation = Quaternion.identity; go.transform.localScale = Vector3.one;
					n++;
				}
				else if (ext == ".ply")
				{
					var mesh = AssetDatabase.LoadAssetAtPath<Mesh>(assetPath) ?? PlyLoader.Load(f);
					var go = new GameObject(Path.GetFileNameWithoutExtension(f));
					go.transform.SetParent(root.transform, false);
					go.AddComponent<MeshFilter>().sharedMesh = mesh;
					var mr = go.AddComponent<MeshRenderer>();
					var sh = Shader.Find("Ortho Earth/Points");
					mr.sharedMaterial = new Material(sh != null ? sh : Shader.Find("Universal Render Pipeline/Unlit"));
					n++;
				}
			}
			Selection.activeGameObject = root;
			Debug.Log($"[Ortho Earth] placed {n} file(s) from {rel} at anchor {anchor.lon}, {anchor.lat}, h {anchor.height} m (X east, Y up, Z north)");
		}
	}
}
