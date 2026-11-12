#ifndef TND_DSP_H
#define TND_DSP_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct TndHandle TndHandle;
typedef struct TndParams {
    float eq[10]; float bass; float treble; float dialogue; float width; float balance;
    float crossfeed; float master_db; float compressor_threshold; float compressor_ratio;
    uint32_t reverb_enabled; uint32_t compressor_enabled; uint32_t bypass;
} TndParams;
typedef struct TndTelemetry {
    float peak_l; float peak_r; float rms_l; float rms_r;
    float spectrum[64]; float waveform[1024]; uint32_t sample_rate; uint32_t reserved; uint64_t heartbeat;
} TndTelemetry;
TndHandle* tnd_create(uint32_t sample_rate, uint32_t channels);
int32_t tnd_set_params(TndHandle* handle, const TndParams* params);
int32_t tnd_process(TndHandle* handle, float* interleaved_stereo, uint32_t frames);
int32_t tnd_read_telemetry(const TndHandle* handle, TndTelemetry* output);
int64_t tnd_latency_100ns(void);
void tnd_destroy(TndHandle* handle);
#ifdef __cplusplus
}
#endif
#endif
