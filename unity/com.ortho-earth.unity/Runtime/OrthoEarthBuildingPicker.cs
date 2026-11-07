// Click a building in Play mode → its PLATEAU attributes (on screen, in the Console and through the Picked event).
//   Put it on any GameObject (e.g. the Main Camera). On Start it gives every OrthoEarthBuilding a MeshCollider (if it has none) so a ray can hit it.
//   Works with the Input System package (Unity 6 default) or the old Input Manager.
using System;
using System.Text;
using UnityEngine;
#if ORTHOEARTH_INPUTSYSTEM
using UnityEngine.InputSystem;
#endif

namespace OrthoEarth
{
	[AddComponentMenu("Ortho Earth/Building Picker")]
	public class OrthoEarthBuildingPicker : MonoBehaviour
	{
		[Tooltip("Camera to cast from (empty = Camera.main)")] public Camera cam;
		[Tooltip("Ray length, metres")] public float maxDistance = 5000;
		[Tooltip("Show the picked building's attributes in a box at the top left")] public bool showPanel = true;
		[Tooltip("Also write them to the Console")] public bool log = true;
		[Tooltip("Tint the picked building")] public Color highlight = new Color(1f, 0.55f, 0.1f);

		public OrthoEarthBuilding Current { get; private set; }
		public event Action<OrthoEarthBuilding> Picked;

		Renderer[] _lit; MaterialPropertyBlock _mpb; string _text; Vector2 _scroll;
		// URP Lit = _BaseColor; glTFast's glTF shaders = baseColorFactor
		static readonly int BaseColor = Shader.PropertyToID("_BaseColor"), BaseColorFactor = Shader.PropertyToID("baseColorFactor");

		void Start()
		{
#pragma warning disable CS0618   // 6000.6 deprecates FindObjectsSortMode, but the no-argument overload does not exist in 6000.0 (the package's minimum)
			var all = FindObjectsByType<OrthoEarthBuilding>(FindObjectsSortMode.None);
#pragma warning restore CS0618
			foreach (var b in all)
				foreach (var mf in b.GetComponentsInChildren<MeshFilter>())
					if (mf.sharedMesh != null && !mf.GetComponent<Collider>()) mf.gameObject.AddComponent<MeshCollider>().sharedMesh = mf.sharedMesh;
		}

		void Update()
		{
			if (!Clicked(out var pos)) return;
			var c = cam != null ? cam : Camera.main;
			if (c == null) return;
			OrthoEarthBuilding hit = null;
			if (Physics.Raycast(c.ScreenPointToRay(pos), out var h, maxDistance)) hit = h.collider.GetComponentInParent<OrthoEarthBuilding>();
			Select(hit);
		}

		bool Clicked(out Vector2 pos)
		{
#if ORTHOEARTH_INPUTSYSTEM
			var m = Mouse.current; pos = m != null ? m.position.ReadValue() : default;
			return m != null && m.leftButton.wasPressedThisFrame;
#elif ENABLE_LEGACY_INPUT_MANAGER
			pos = Input.mousePosition; return Input.GetMouseButtonDown(0);
#else
			pos = default; return false;
#endif
		}

		/// <summary>Select a building from code (null clears).</summary>
		public void Select(OrthoEarthBuilding b)
		{
			Tint(false);
			Current = b;
			_lit = b != null ? b.GetComponentsInChildren<Renderer>() : null;
			Tint(true);
			_text = b == null ? null : Describe(b);
			if (b != null && log) Debug.Log(_text, b);
			Picked?.Invoke(b);
		}

		void Tint(bool on)
		{
			if (_lit == null) return;
			_mpb ??= new MaterialPropertyBlock();
			foreach (var r in _lit)
			{
				if (r == null) continue;
				if (on) { r.GetPropertyBlock(_mpb); _mpb.SetColor(BaseColor, highlight); _mpb.SetColor(BaseColorFactor, highlight); r.SetPropertyBlock(_mpb); }
				else r.SetPropertyBlock(null);
			}
		}

		public static string Describe(OrthoEarthBuilding b)
		{
			var sb = new StringBuilder();
			sb.Append(b.Name ?? b.id).Append('\n');
			foreach (var kv in b.Attributes) sb.Append(kv.Key).Append(": ").Append(kv.Value).Append('\n');
			return sb.ToString();
		}

		void OnGUI()
		{
			if (!showPanel || string.IsNullOrEmpty(_text)) return;
			var r = new Rect(10, 10, Mathf.Min(460, Screen.width - 20), Mathf.Min(420, Screen.height - 20));
			GUILayout.BeginArea(r, GUI.skin.box);
			_scroll = GUILayout.BeginScrollView(_scroll);
			GUILayout.Label(_text);
			GUILayout.EndScrollView();
			GUILayout.EndArea();
		}
	}
}
