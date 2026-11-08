#include "OrthoEarthGeo.h"

namespace OrthoEarth
{
	static constexpr double D2R = UE_DOUBLE_PI / 180.0;

	void LonLatToEcef(double Lon, double Lat, double H, double& X, double& Y, double& Z)
	{
		const double La = Lat * D2R, Lo = Lon * D2R, S = FMath::Sin(La), N = WGS84_A / FMath::Sqrt(1 - WGS84_E2 * S * S);
		X = (N + H) * FMath::Cos(La) * FMath::Cos(Lo);
		Y = (N + H) * FMath::Cos(La) * FMath::Sin(Lo);
		Z = (N * (1 - WGS84_E2) + H) * S;
	}

	void EcefToLonLat(double X, double Y, double Z, double& Lon, double& Lat, double& H)
	{
		const double P = FMath::Sqrt(X * X + Y * Y);
		double La = FMath::Atan2(Z, P * (1 - WGS84_E2)), N = WGS84_A;
		for (int32 i = 0; i < 8; i++) { const double S = FMath::Sin(La); N = WGS84_A / FMath::Sqrt(1 - WGS84_E2 * S * S); La = FMath::Atan2(Z + WGS84_E2 * N * S, P); }
		Lon = FMath::Atan2(Y, X) / D2R; Lat = La / D2R;
		H = P / FMath::Cos(La) - N;
	}

	/** ENU basis at the anchor: E, N, U as ECEF unit vectors. */
	static void Basis(const FOrthoEarthGeoAnchor& A, FVector& E, FVector& N, FVector& U)
	{
		const double Lo = A.Lon * D2R, La = A.Lat * D2R, Sl = FMath::Sin(Lo), Cl = FMath::Cos(Lo), Sa = FMath::Sin(La), Ca = FMath::Cos(La);
		E = FVector(-Sl, Cl, 0); N = FVector(-Sa * Cl, -Sa * Sl, Ca); U = FVector(Ca * Cl, Ca * Sl, Sa);
	}

	FVector EnuOf(const FOrthoEarthGeoAnchor& A, double Lon, double Lat, double H)
	{
		double Ax, Ay, Az, Px, Py, Pz;
		LonLatToEcef(A.Lon, A.Lat, A.Height, Ax, Ay, Az);
		LonLatToEcef(Lon, Lat, H, Px, Py, Pz);
		FVector E, N, U; Basis(A, E, N, U);
		const FVector D(Px - Ax, Py - Ay, Pz - Az);
		return FVector(FVector::DotProduct(E, D), FVector::DotProduct(N, D), FVector::DotProduct(U, D));
	}

	FVector LocalOf(const FOrthoEarthGeoAnchor& A, double Lon, double Lat, double H)
	{
		const FVector Enu = EnuOf(A, Lon, Lat, H);
		// world ENU → model frame (undo heading): model north points at bearing Heading
		const double Ps = A.Heading * D2R, C = FMath::Cos(Ps), S = FMath::Sin(Ps);
		const double Me = Enu.X * C - Enu.Y * S, Mn = Enu.X * S + Enu.Y * C;
		return FVector(Me, -Mn, Enu.Z) * 100.0;   // (east, south, up) cm
	}

	void GeoOf(const FOrthoEarthGeoAnchor& A, const FVector& Local, double& Lon, double& Lat, double& H)
	{
		const double Me = Local.X / 100.0, Mn = -Local.Y / 100.0, Up = Local.Z / 100.0;
		const double Ps = A.Heading * D2R, C = FMath::Cos(Ps), S = FMath::Sin(Ps);
		const double Ee = Me * C + Mn * S, Nn = -Me * S + Mn * C;   // model frame → world ENU
		double Ax, Ay, Az; LonLatToEcef(A.Lon, A.Lat, A.Height, Ax, Ay, Az);
		FVector E, N, U; Basis(A, E, N, U);
		const FVector P = FVector(Ax, Ay, Az) + E * Ee + N * Nn + U * Up;
		EcefToLonLat(P.X, P.Y, P.Z, Lon, Lat, H);
	}
}
