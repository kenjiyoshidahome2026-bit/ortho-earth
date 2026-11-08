// Building attributes of one ortho-export folder (buildings.attributes.json → this asset).
//   ortho-export splits PLATEAU buildings into one glTF node per building (node name = gml_id) and writes their CityGML attributes
//   (the 3D Tiles batch table) as a flat table: keys[] shared by all buildings, one values[] row per building in the same order ("" = none).
//   "Ortho Earth > Place export folder in scene…" turns the JSON into this asset and gives every building GameObject an OrthoEarthBuilding
//   that points here. Look up by id at runtime with Find / TryGet.
using System;
using System.Collections.Generic;
using UnityEngine;

namespace OrthoEarth
{
	[CreateAssetMenu(menuName = "Ortho Earth/Attribute table", fileName = "buildings.attributes")]
	public class OrthoEarthAttributeTable : ScriptableObject
	{
		[Serializable] public class Row { public string id; public string[] values; }

		[Tooltip("Attribute names shared by all rows (PLATEAU / CityGML keys, nested ones joined with '/')")] public string[] keys = Array.Empty<string>();
		public List<Row> buildings = new List<Row>();
		[Tooltip("Attribution of the data (keep it with any redistribution)")] public string source;

		[NonSerialized] Dictionary<string, int> _byId;
		[NonSerialized] Dictionary<string, int> _byKey;

		public int Count => buildings.Count;

		/// <summary>Row index of a building id (gml_id), or −1.</summary>
		public int IndexOf(string id)
		{
			if (_byId == null || _byId.Count != buildings.Count)
			{
				_byId = new Dictionary<string, int>(buildings.Count);
				for (int i = 0; i < buildings.Count; i++) if (buildings[i].id != null) _byId[buildings[i].id] = i;
			}
			return id != null && _byId.TryGetValue(id, out var r) ? r : -1;
		}
		/// <summary>Column index of an attribute name, or −1.</summary>
		public int KeyIndex(string key)
		{
			if (_byKey == null || _byKey.Count != keys.Length)
			{
				_byKey = new Dictionary<string, int>(keys.Length);
				for (int i = 0; i < keys.Length; i++) _byKey[keys[i]] = i;
			}
			return key != null && _byKey.TryGetValue(key, out var k) ? k : -1;
		}
		public Row Find(string id) { var i = IndexOf(id); return i < 0 ? null : buildings[i]; }

		/// <summary>Attribute value of a building ("" counts as missing).</summary>
		public bool TryGet(string id, string key, out string value)
		{
			value = null;
			var r = Find(id); var k = KeyIndex(key);
			if (r == null || k < 0 || r.values == null || k >= r.values.Length || string.IsNullOrEmpty(r.values[k])) return false;
			value = r.values[k]; return true;
		}

		/// <summary>The non-empty attributes of a building, in key order.</summary>
		public IEnumerable<KeyValuePair<string, string>> AttributesOf(string id)
		{
			var r = Find(id);
			if (r?.values == null) yield break;
			for (int i = 0; i < keys.Length && i < r.values.Length; i++)
				if (!string.IsNullOrEmpty(r.values[i])) yield return new KeyValuePair<string, string>(keys[i], r.values[i]);
		}

		[Serializable] class Json { public int version; public string[] keys; public List<Row> buildings; public string source; }
		/// <summary>Fill from buildings.attributes.json (ortho-export).</summary>
		public void LoadJson(string json)
		{
			var j = JsonUtility.FromJson<Json>(json);
			keys = j?.keys ?? Array.Empty<string>();
			buildings = j?.buildings ?? new List<Row>();
			source = j?.source;
			_byId = null; _byKey = null;
		}
	}
}
