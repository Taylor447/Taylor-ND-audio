#pragma once
#include <Windows.h>
#include <cstdint>
#include "tnd_dsp.h"

// Bố cục này phải giữ đồng bộ với SharedBlock trong dsp-core/src/lib.rs.
constexpr uint32_t TND_SHARED_MAGIC = 0x544E4441; // "TNDA"
constexpr uint32_t TND_SHARED_VERSION = 1;
constexpr LONG TND_TELEMETRY_SLOTS = 8;

struct alignas(8) TndSharedBlock {
    uint32_t magic;
    uint32_t version;
    volatile LONG64 profileSequence;
    TndParams profile;
    volatile LONG nextTelemetrySlot;
    uint32_t reserved;
    volatile LONG64 telemetrySequence[TND_TELEMETRY_SLOTS];
    TndTelemetry telemetry[TND_TELEMETRY_SLOTS];
};

static_assert(alignof(TndSharedBlock) == 8, "Shared mapping cần căn chỉnh 8 byte");
static_assert(offsetof(TndSharedBlock, profileSequence) == 8, "ABI: profileSequence");
static_assert(offsetof(TndSharedBlock, profile) == 16, "ABI: profile");
static_assert(offsetof(TndSharedBlock, telemetrySequence) == 112, "ABI: telemetrySequence");
static_assert(offsetof(TndSharedBlock, telemetry) == 176, "ABI: telemetry");
static_assert(sizeof(TndSharedBlock) == 35248, "ABI: kích thước SharedBlock version 1");
