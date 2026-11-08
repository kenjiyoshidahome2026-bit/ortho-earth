#include "OrthoEarthLas.h"
#include "HAL/PlatformFileManager.h"
#include "GenericPlatform/GenericPlatformFile.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace OrthoEarth
{
	static uint16 U16(const uint8* P) { return uint16(P[0]) | uint16(P[1]) << 8; }
	static uint32 U32(const uint8* P) { return uint32(P[0]) | uint32(P[1]) << 8 | uint32(P[2]) << 16 | uint32(P[3]) << 24; }

	bool ReadLasAnchor(const FString& Path, FLasAnchor& Out)
	{
		TUniquePtr<IFileHandle> F(FPlatformFileManager::Get().GetPlatformFile().OpenRead(*Path));
		if (!F) return false;
		uint8 H[104];
		if (!F->Read(H, sizeof H) || FMemory::Memcmp(H, "LASF", 4) != 0) return false;
		const uint16 HeaderSize = U16(H + 94);
		const uint32 NumVlr = U32(H + 100);
		int64 Pos = HeaderSize;
		for (uint32 i = 0; i < NumVlr && i < 256; i++)
		{
			uint8 V[54];
			if (!F->Seek(Pos) || !F->Read(V, sizeof V)) return false;
			const uint16 Len = U16(V + 20);
			const FString User = FString(16, reinterpret_cast<const ANSICHAR*>(V + 2)).TrimEnd();
			if (User.StartsWith(TEXT("orthoEarth")) && U16(V + 18) == 1)
			{
				TArray<uint8> Body; Body.SetNumUninitialized(Len + 1);
				if (!F->Read(Body.GetData(), Len)) return false;
				Body[Len] = 0;
				const FString Text = UTF8_TO_TCHAR(reinterpret_cast<const ANSICHAR*>(Body.GetData()));
				TSharedPtr<FJsonObject> J; const TSharedPtr<FJsonObject>* A = nullptr;
				if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), J) || !J || !J->TryGetObjectField(TEXT("anchor"), A)) return false;
				(*A)->TryGetNumberField(TEXT("lon"), Out.Lon); (*A)->TryGetNumberField(TEXT("lat"), Out.Lat); (*A)->TryGetNumberField(TEXT("height"), Out.Height);
				FString Datum; Out.bOrthometric = !(*A)->TryGetStringField(TEXT("datum"), Datum) || Datum == TEXT("orthometric");
				return true;
			}
			Pos += 54 + Len;
		}
		return false;
	}
}
