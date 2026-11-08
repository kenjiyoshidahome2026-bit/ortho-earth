// Ortho Earth > Place export folder in scene…
//   Pick a folder written by ortho-export that you copied under Assets/ (e.g. Assets/OrthoEarth/marunouchi/). glTFast's importer has already turned
//   each .glb into a prefab; this puts them all under one GameObject carrying OrthoEarthAnchor (from anchor.json) and loads .ply point clouds.
//   Frames: the GLBs are in the Cesium/ortho-earth glTF frame (X east, Y up, Z south). glTFast converts right- to left-handed by flipping X
//   (glTFast ≥ 4: UpgradeGuides.md), so the prefabs come in as (west, up, south) = the ENU frame turned 180° about Y. One intermediate node
//   "glTF frame" rotated 180° about Y undoes that, so the anchor GameObject itself is X east, Y up, Z north at identity (what Geo/OrthoEarthAnchor assume).
//   PLY point clouds are loaded straight into the anchor frame (PlyLoader flips Z), so they sit under the anchor, not under the glTF node.
//   Building attributes: when <name>.attributes.json sits next to <name>.glb (ortho-export writes buildings.attributes.json), it becomes an
//   OrthoEarthAttributeTable asset beside it and every GameObject whose name is a row id (gml_id) gets an OrthoEarthBuilding pointing at it.
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OrthoEarth.Editor
{
	public static class OrthoEarthPlaceMenu
	{
		/// <summary>buildings.attributes.json → OrthoEarthAttributeTable asset (created or refreshed in place, so references survive a re-export).</summary>
		public static OrthoEarthAttributeTable LoadTable(string jsonPath, string assetPath)
		{
			var table = AssetDatabase.LoadAssetAtPath<OrthoEarthAttributeTable>(assetPath);
			var fresh = table == null;
			if (fresh) table = ScriptableObject.CreateInstance<OrthoEarthAttributeTable>();
			table.LoadJson(File.ReadAllText(jsonPath));
			if (fresh) AssetDatabase.CreateAsset(table, assetPath); else EditorUtility.SetDirty(table);
			AssetDatabase.SaveAssets();
			return table;
		}

		/// <summary>Give every GameObject under root whose name is a building id an OrthoEarthBuilding. Returns how many.</summary>
		public static int AttachBuildings(GameObject root, OrthoEarthAttributeTable table)
		{
			int n = 0;
			foreach (var t in root.GetComponentsInChildren<Transform>(true))
			{
				if (table.IndexOf(t.name) < 0) continue;
				if (!t.TryGetComponent<OrthoEarthBuilding>(out var b)) b = Undo.AddComponent<OrthoEarthBuilding>(t.gameObject);
				b.id = t.name; b.table = table;
				n++;
			}
			return n;
		}

		static void EditorSceneManagerMarkDirty(GameObject go) => UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);

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
			var gltfNode = new GameObject(OrthoEarthFrames.GltfNodeName);
			gltfNode.transform.SetParent(root.transform, false);
			gltfNode.transform.localRotation = OrthoEarthFrames.GltfToAnchor;

			int n = 0;
			foreach (var f in Directory.GetFiles(abs))
			{
				var ext = Path.GetExtension(f).ToLowerInvariant();
				var assetPath = rel + "/" + Path.GetFileName(f);
				if (ext == ".glb" || ext == ".gltf")
				{
					var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(assetPath);
					if (prefab == null) { Debug.LogWarning($"[Ortho Earth] {assetPath}: not imported yet (is glTFast installed?)"); continue; }
					var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab, gltfNode.transform);
					go.transform.localPosition = Vector3.zero; go.transform.localRotation = Quaternion.identity; go.transform.localScale = Vector3.one;
					n++;
					var attrJson = Path.Combine(abs, Path.GetFileNameWithoutExtension(f) + ".attributes.json");
					if (File.Exists(attrJson))
					{
						var table = LoadTable(attrJson, rel + "/" + Path.GetFileNameWithoutExtension(f) + ".attributes.asset");
						var tagged = AttachBuildings(go, table);
						Debug.Log($"[Ortho Earth] {assetPath}: {tagged} of {table.Count} building(s) carry attributes (select one to see them; add Ortho Earth/Building Picker to click them in Play mode)");
					}
				}
				else if (ext == ".ply")
				{
					var mesh = AssetDatabase.LoadAssetAtPath<Mesh>(assetPath) ?? PlyLoader.Load(f);
					var go = new GameObject(Path.GetFileNameWithoutExtension(f));
					go.transform.SetParent(root.transform, false);
					// a PLY from /japan/pointcloud carries its own anchor (header comment, orthometric height): offset it to this folder's anchor
					var pa = PlyLoader.ReadAnchor(f);
					if (pa != null) go.transform.localPosition = anchor.LocalOf(pa.lon, pa.lat, pa.h + (pa.orthometric ? anchor.geoid : 0));
					go.AddComponent<MeshFilter>().sharedMesh = mesh;
					var mr = go.AddComponent<MeshRenderer>();
					var sh = Shader.Find("Ortho Earth/Points");
					mr.sharedMaterial = new Material(sh != null ? sh : Shader.Find("Universal Render Pipeline/Unlit"));
					n++;
				}
			}
			Selection.activeGameObject = root;
			EditorSceneManagerMarkDirty(root);
			Debug.Log($"[Ortho Earth] placed {n} file(s) from {rel} at anchor {anchor.lon}, {anchor.lat}, h {anchor.height} m (X east, Y up, Z north)");
		}
	}
}
