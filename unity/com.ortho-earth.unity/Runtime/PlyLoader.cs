// Binary little-endian PLY → Mesh of points (MeshTopology.Points). Reads x y z (float/double), red green blue (uchar) and classification (uchar) if present.
//   This is what /japan/pointcloud writes ("download the range as PLY", ortho-export design §3.3): positions are metres relative to the anchor,
//   in the glTF frame (X east, Y up, Z south), so Z is flipped here to Unity's Z north. Classification goes to uv0.x for shaders that want it.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEngine;
using UnityEngine.Rendering;

namespace OrthoEarth
{
	public static class PlyLoader
	{
		class Prop { public string name, type; }

		public static Mesh Load(string path, bool flipZ = true)
		{
			using var fs = File.OpenRead(path);
			return Load(fs, flipZ, Path.GetFileNameWithoutExtension(path));
		}

		public static Mesh Load(Stream s, bool flipZ = true, string name = "pointcloud")
		{
			// header (ASCII, ends with "end_header\n")
			var header = new StringBuilder();
			int b, prev = -1;
			while ((b = s.ReadByte()) >= 0) { header.Append((char)b); if (b == '\n' && header.ToString().EndsWith("end_header\n")) break; prev = b; }
			var lines = header.ToString().Split('\n');
			int count = 0; var props = new List<Prop>(); bool le = false, inVertex = false;
			foreach (var raw in lines)
			{
				var l = raw.Trim(); if (l.Length == 0) continue;
				var w = l.Split(' ');
				if (w[0] == "format") le = w[1] == "binary_little_endian";
				else if (w[0] == "element") { inVertex = w[1] == "vertex"; if (inVertex) count = int.Parse(w[2]); }
				else if (w[0] == "property" && inVertex) { if (w[1] == "list") throw new NotSupportedException("PLY: list properties on vertices"); props.Add(new Prop { type = w[1], name = w[2] }); }
			}
			if (!le) throw new NotSupportedException("PLY: only binary_little_endian is supported");
			int stride = 0; var off = new Dictionary<string, (int off, string type)>();
			foreach (var p in props) { off[p.name] = (stride, p.type); stride += Size(p.type); }
			var pos = new Vector3[count]; var col = off.ContainsKey("red") ? new Color32[count] : null; var cls = off.ContainsKey("classification") ? new Vector2[count] : null;
			var buf = new byte[stride];
			for (int i = 0; i < count; i++)
			{
				int got = 0; while (got < stride) { int r = s.Read(buf, got, stride - got); if (r <= 0) throw new EndOfStreamException("PLY: short vertex data"); got += r; }
				float x = (float)Num(buf, off["x"]), y = (float)Num(buf, off["y"]), z = (float)Num(buf, off["z"]);
				pos[i] = new Vector3(x, y, flipZ ? -z : z);
				if (col != null) col[i] = new Color32((byte)Num(buf, off["red"]), (byte)Num(buf, off["green"]), (byte)Num(buf, off["blue"]), 255);
				if (cls != null) cls[i] = new Vector2((float)Num(buf, off["classification"]), 0);
			}
			var m = new Mesh { name = name, indexFormat = count > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
			m.SetVertices(pos);
			if (col != null) m.SetColors(col);
			if (cls != null) m.SetUVs(0, cls);
			var idx = new int[count]; for (int i = 0; i < count; i++) idx[i] = i;
			m.SetIndices(idx, MeshTopology.Points, 0);
			m.RecalculateBounds();
			return m;
		}

		static int Size(string t) => t switch { "char" or "uchar" or "int8" or "uint8" => 1, "short" or "ushort" or "int16" or "uint16" => 2, "int" or "uint" or "float" or "int32" or "uint32" or "float32" => 4, "double" or "float64" => 8, _ => throw new NotSupportedException("PLY type " + t) };
		static double Num(byte[] b, (int off, string type) p) => p.type switch
		{
			"char" or "int8" => (sbyte)b[p.off], "uchar" or "uint8" => b[p.off],
			"short" or "int16" => BitConverter.ToInt16(b, p.off), "ushort" or "uint16" => BitConverter.ToUInt16(b, p.off),
			"int" or "int32" => BitConverter.ToInt32(b, p.off), "uint" or "uint32" => BitConverter.ToUInt32(b, p.off),
			"float" or "float32" => BitConverter.ToSingle(b, p.off), "double" or "float64" => BitConverter.ToDouble(b, p.off),
			_ => 0,
		};
	}
}
