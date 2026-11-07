// Unlit vertex-colour point shader for URP (point clouds from PlyLoader). Point size is 1 px on most GPUs (Unity has no point-size control on Metal/D3D).
Shader "Ortho Earth/Points"
{
	Properties { _Tint ("Tint", Color) = (1, 1, 1, 1) }
	SubShader
	{
		Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry" }
		Pass
		{
			Name "Unlit"
			HLSLPROGRAM
			#pragma vertex vert
			#pragma fragment frag
			#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
			struct Attributes { float4 positionOS : POSITION; float4 color : COLOR; };
			struct Varyings { float4 positionHCS : SV_POSITION; float4 color : COLOR; };
			CBUFFER_START(UnityPerMaterial) float4 _Tint; CBUFFER_END
			Varyings vert(Attributes v) { Varyings o; o.positionHCS = TransformObjectToHClip(v.positionOS.xyz); o.color = v.color; return o; }
			half4 frag(Varyings i) : SV_Target { return half4(i.color.rgb * _Tint.rgb, 1); }
			ENDHLSL
		}
	}
	Fallback "Hidden/Universal Render Pipeline/FallbackError"
}
