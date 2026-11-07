// Geodesy for the ortho-earth anchor (docs/notes/unity-roundtrip.md §2). Double precision: ECEF magnitudes are ~6.4e6 m.
//   ENU at the anchor = X east, Y north, Z up (metres). Unity = X east, Y up, Z north (left-handed).
//   glTF (the file) = X east, Y up, Z south; glTFast flips Z on import/export, so this code never sees the glTF frame.
using System;
using UnityEngine;

namespace OrthoEarth
{
	public static class Geo
	{
		public const double A = 6378137.0, F = 1.0 / 298.257223563, E2 = F * (2 - F);
		const double D2R = Math.PI / 180.0;

		/// <summary>lon/lat (degrees) + ellipsoidal height (m) → ECEF (m).</summary>
		public static void LonLatToEcef(double lon, double lat, double h, out double x, out double y, out double z)
		{
			double la = lat * D2R, lo = lon * D2R, s = Math.Sin(la), n = A / Math.Sqrt(1 - E2 * s * s);
			x = (n + h) * Math.Cos(la) * Math.Cos(lo);
			y = (n + h) * Math.Cos(la) * Math.Sin(lo);
			z = (n * (1 - E2) + h) * s;
		}

		/// <summary>ECEF (m) → lon/lat (degrees) + ellipsoidal height (m).</summary>
		public static void EcefToLonLat(double x, double y, double z, out double lon, out double lat, out double h)
		{
			lon = Math.Atan2(y, x);
			double p = Math.Sqrt(x * x + y * y), la = Math.Atan2(z, p * (1 - E2)), n = A;
			for (int i = 0; i < 8; i++) { double s = Math.Sin(la); n = A / Math.Sqrt(1 - E2 * s * s); la = Math.Atan2(z + E2 * n * s, p); }
			lat = la / D2R; lon /= D2R;
			h = p / Math.Cos(la) - n;
		}

		/// <summary>ENU basis at lon/lat: rows E, N, U as ECEF unit vectors.</summary>
		public static void EnuBasis(double lon, double lat, out double[] e, out double[] n, out double[] u)
		{
			double lo = lon * D2R, la = lat * D2R, sl = Math.Sin(lo), cl = Math.Cos(lo), sa = Math.Sin(la), ca = Math.Cos(la);
			e = new[] { -sl, cl, 0 };
			n = new[] { -sa * cl, -sa * sl, ca };
			u = new[] { ca * cl, ca * sl, sa };
		}
	}

	/// <summary>An anchor: the point of the Earth that is the origin of this Unity scene (or of one export folder).</summary>
	[Serializable]
	public struct Anchor
	{
		public double lon, lat, height;   // degrees, degrees, ellipsoidal metres
		public double heading;            // degrees clockwise from north: rotation of the model around the up axis (0 = model +Z is north)

		public Anchor(double lon, double lat, double height, double heading = 0) { this.lon = lon; this.lat = lat; this.height = height; this.heading = heading; }

		/// <summary>lon/lat/height → Unity local position (X east, Y up, Z north), heading applied.</summary>
		public Vector3 ToLocal(double lon, double lat, double h)
		{
			Geo.LonLatToEcef(this.lon, this.lat, height, out var ax, out var ay, out var az);
			Geo.LonLatToEcef(lon, lat, h, out var px, out var py, out var pz);
			Geo.EnuBasis(this.lon, this.lat, out var E, out var N, out var U);
			double dx = px - ax, dy = py - ay, dz = pz - az;
			double e = E[0] * dx + E[1] * dy + E[2] * dz, n = N[0] * dx + N[1] * dy + N[2] * dz, u = U[0] * dx + U[1] * dy + U[2] * dz;
			// world ENU → model frame (undo heading): model north points at bearing `heading`
			double ps = heading * Math.PI / 180, c = Math.Cos(ps), s = Math.Sin(ps);
			double me = e * c - n * s, mn = e * s + n * c;
			return new Vector3((float)me, (float)u, (float)mn);
		}

		/// <summary>Unity local position → lon/lat/height.</summary>
		public void FromLocal(Vector3 p, out double lon, out double lat, out double h)
		{
			double ps = heading * Math.PI / 180, c = Math.Cos(ps), s = Math.Sin(ps);
			double e = p.x * c + p.z * s, n = -p.x * s + p.z * c, u = p.y;   // model frame → world ENU
			Geo.LonLatToEcef(this.lon, this.lat, height, out var ax, out var ay, out var az);
			Geo.EnuBasis(this.lon, this.lat, out var E, out var N, out var U);
			Geo.EcefToLonLat(ax + E[0] * e + N[0] * n + U[0] * u, ay + E[1] * e + N[1] * n + U[1] * u, az + E[2] * e + N[2] * n + U[2] * u, out lon, out lat, out h);
		}
	}
}
