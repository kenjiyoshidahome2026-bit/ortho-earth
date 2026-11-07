// The anchor of a scene (or of one imported export folder): where Unity's origin is on the Earth.
//   Put it on the parent GameObject of the imported GLBs (identity transform). Everything under it is in metres, X east, Y up, Z north
//   (glTFast prefabs sit one level down, under the "glTF frame" node that Place rotates 180° about Y: see Geo.cs).
//   The same component is read by the exporter (Ortho Earth > Export selection to GLB…) to stamp asset.extras.orthoEarth into the GLB,
//   which ortho-earth (map.gadget.model / drop onto the globe) and glbconv read to place the model on the globe.
using UnityEngine;

namespace OrthoEarth
{
	[AddComponentMenu("Ortho Earth/Anchor")]
	[DisallowMultipleComponent]
	public class OrthoEarthAnchor : MonoBehaviour
	{
		[Tooltip("Longitude of the local origin, degrees (east positive)")] public double lon = 139.7671;
		[Tooltip("Latitude of the local origin, degrees (north positive)")] public double lat = 35.6812;
		[Tooltip("Ellipsoidal height (WGS84/GRS80, metres) of the local origin — NOT the orthometric elevation. ortho-export writes the ground height here")] public double height = 40;
		[Tooltip("Degrees clockwise from north that the model's +Z axis points to. 0 = +Z is north")] public double heading = 0;
		[Tooltip("Geoid height at the anchor (metres), informational: ellipsoidal = orthometric + geoid")] public double geoid = 0;
		[Tooltip("Bounding box of the export, degrees [west, south, east, north] (informational)")] public double[] bbox;

		public Anchor Value => new Anchor(lon, lat, height, heading);

		/// <summary>Local position (this transform's space) of a geographic point.</summary>
		public Vector3 LocalOf(double lon, double lat, double h) => Value.ToLocal(lon, lat, h);
		/// <summary>World position of a geographic point (this anchor's transform applied).</summary>
		public Vector3 WorldOf(double lon, double lat, double h) => transform.TransformPoint(LocalOf(lon, lat, h));
		/// <summary>Geographic point of a world position.</summary>
		public void GeoOf(Vector3 world, out double lon, out double lat, out double h) => Value.FromLocal(transform.InverseTransformPoint(world), out lon, out lat, out h);

		/// <summary>Fill from an anchor.json written by ortho-export.</summary>
		public void Apply(AnchorJson j)
		{
			lon = j.anchor.lon; lat = j.anchor.lat; height = j.anchor.height; heading = j.heading; geoid = j.geoid; bbox = j.bbox;
		}
	}

	/// <summary>Shape of anchor.json (ortho-export) and of asset.extras.orthoEarth inside the GLBs. JsonUtility reads/writes it.</summary>
	[System.Serializable]
	public class AnchorJson
	{
		[System.Serializable] public class Point { public double lon, lat, height; }
		public int version = 1;
		public Point anchor = new Point();
		public string frame = "enu";
		public double heading = 0;
		public double geoid = 0;
		public double[] bbox;
		public string generator;

		public static AnchorJson FromAnchor(OrthoEarthAnchor a, string generator) => new AnchorJson
		{
			anchor = new Point { lon = a.lon, lat = a.lat, height = a.height }, heading = a.heading, geoid = a.geoid, bbox = a.bbox, generator = generator,
		};
	}
}
