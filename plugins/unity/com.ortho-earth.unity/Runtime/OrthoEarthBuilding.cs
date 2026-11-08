// One PLATEAU building in the scene: its id (gml_id = the GameObject name ortho-export gave the glTF node) and its attributes.
//   Added by "Ortho Earth > Place export folder in scene…". Select a building in the Scene view (click twice: the first click selects the
//   prefab root) to see its attributes in the Inspector. At runtime: GetComponentInParent<OrthoEarthBuilding>() on a raycast hit, then Get(key)
//   (OrthoEarthBuildingPicker does that on click).
using System.Collections.Generic;
using UnityEngine;

namespace OrthoEarth
{
	[AddComponentMenu("Ortho Earth/Building")]
	[DisallowMultipleComponent]
	public class OrthoEarthBuilding : MonoBehaviour
	{
		[Tooltip("PLATEAU gml_id (the glTF node name)")] public string id;
		public OrthoEarthAttributeTable table;

		/// <summary>Attribute value, or null. Keys are the PLATEAU/CityGML names, e.g. "bldg:usage", "bldg:measuredHeight", "gml:name", "uro:BuildingIDAttribute/uro:buildingID".</summary>
		public string Get(string key) => table != null && table.TryGet(id, key, out var v) ? v : null;
		public bool TryGet(string key, out string value) { value = Get(key); return value != null; }
		/// <summary>Attribute as a number (NaN when missing or not a number; PLATEAU writes −9999 / 9999 for "unknown" inside the CityGML attributes).</summary>
		public double GetNumber(string key) => double.TryParse(Get(key), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) ? d : double.NaN;
		/// <summary>All non-empty attributes, in table order.</summary>
		public IEnumerable<KeyValuePair<string, string>> Attributes => table != null ? table.AttributesOf(id) : System.Array.Empty<KeyValuePair<string, string>>();

		/// <summary>Building name (gml:name), if any.</summary>
		public string Name => Get("gml:name");
		/// <summary>Usage (bldg:usage), e.g. 業務施設.</summary>
		public string Usage => Get("bldg:usage");
		/// <summary>Measured height in metres (bldg:measuredHeight), NaN if missing.</summary>
		public double MeasuredHeight => GetNumber("bldg:measuredHeight");
		/// <summary>Storeys above ground (bldg:storeysAboveGround), NaN if missing or unknown (9999).</summary>
		public double StoreysAboveGround { get { var v = GetNumber("bldg:storeysAboveGround"); return v >= 9999 ? double.NaN : v; } }
	}
}
