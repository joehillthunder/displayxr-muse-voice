// displayxr_dial: a rotary encoder (depth) and a push button (2D/3D) for the display.
//
// Sends bridge commands (docs/protocol.md) straight to the displayxr-muse-voice bridge over a
// WebSocket on the LAN. It does not go through Muse: a dial wants low latency, and the bridge
// already accepts any authenticated source.
//
// UNTESTED ON HARDWARE. Written against ESP-IDF 5.1+/6.0 (pulse_cnt, gpio) and
// espressif/esp_websocket_client 1.2, the versions the Muse ESP32 SDK pins.

#include "displayxr_dial.h"

#include "sdkconfig.h"

#if !CONFIG_DXR_DIAL_ENABLED

// The main component always links this one; with the dial off it compiles to a no-op.
void displayxr_dial_start(void) {}

#else

#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "driver/gpio.h"
#include "driver/pulse_cnt.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "dxr.dial";

#define COUNTS_PER_DETENT 4          // x4 quadrature decoding of a typical EC11 encoder
#define DEPTH_PER_DETENT 0.05f       // 20 detents from the screen plane to fully out
#define SEND_INTERVAL_US (100 * 1000) // coalesce dial turns to at most 10 sends/s
#define POLL_MS 20
#define DEBOUNCE_MS 40

static esp_websocket_client_handle_t s_ws;
static volatile bool s_welcomed;
static uint32_t s_seq;

// ── Bridge ───────────────────────────────────────────────────────────────────────────────

static void send_json(cJSON *msg) {
    if (!s_ws || !s_welcomed || !esp_websocket_client_is_connected(s_ws)) {
        cJSON_Delete(msg);
        return;
    }
    char *text = cJSON_PrintUnformatted(msg);
    cJSON_Delete(msg);
    if (!text) return;
    if (esp_websocket_client_send_text(s_ws, text, strlen(text), pdMS_TO_TICKS(1000)) < 0) {
        ESP_LOGW(TAG, "send failed");
    }
    cJSON_free(text);
}

static void send_command(const char *cmd, cJSON *args) {
    char id[24];
    snprintf(id, sizeof id, "dial-%lu", (unsigned long)++s_seq);
    cJSON *msg = cJSON_CreateObject();
    cJSON_AddNumberToObject(msg, "v", 1);
    cJSON_AddStringToObject(msg, "type", "command");
    cJSON_AddStringToObject(msg, "id", id);
    cJSON_AddStringToObject(msg, "cmd", cmd);
    cJSON_AddItemToObject(msg, "args", args ? args : cJSON_CreateObject());
    send_json(msg);
}

static void on_ws_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    esp_websocket_event_data_t *ev = (esp_websocket_event_data_t *)data;
    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED: {
        s_welcomed = false;
        cJSON *hello = cJSON_CreateObject();
        cJSON_AddNumberToObject(hello, "v", 1);
        cJSON_AddStringToObject(hello, "type", "hello");
        cJSON_AddStringToObject(hello, "role", "source");
        cJSON_AddStringToObject(hello, "name", "esp32-dial");
        cJSON_AddStringToObject(hello, "secret", CONFIG_DXR_DIAL_BRIDGE_SECRET);
        char *text = cJSON_PrintUnformatted(hello);
        cJSON_Delete(hello);
        if (text) {
            esp_websocket_client_send_text(s_ws, text, strlen(text), pdMS_TO_TICKS(1000));
            cJSON_free(text);
        }
        break;
    }
    case WEBSOCKET_EVENT_DATA:
        if (ev->op_code == 0x1 && ev->data_len > 0) {
            cJSON *msg = cJSON_ParseWithLength(ev->data_ptr, ev->data_len);
            const cJSON *type = cJSON_GetObjectItemCaseSensitive(msg, "type");
            if (cJSON_IsString(type) && strcmp(type->valuestring, "welcome") == 0) {
                s_welcomed = true;
                ESP_LOGI(TAG, "connected to the bridge");
            } else if (cJSON_IsString(type) && strcmp(type->valuestring, "ack") == 0) {
                const cJSON *ok = cJSON_GetObjectItemCaseSensitive(msg, "ok");
                const cJSON *err = cJSON_GetObjectItemCaseSensitive(msg, "error");
                if (cJSON_IsFalse(ok) && cJSON_IsString(err)) ESP_LOGW(TAG, "display: %s", err->valuestring);
            }
            cJSON_Delete(msg);
        } else if (ev->op_code == 0x8) {
            ESP_LOGW(TAG, "bridge closed the connection (wrong secret?)");
        }
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
        s_welcomed = false;
        break;
    default:
        break;
    }
}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────

static pcnt_unit_handle_t encoder_init(void) {
    pcnt_unit_config_t unit_cfg = {.high_limit = 1000, .low_limit = -1000};
    pcnt_unit_handle_t unit = NULL;
    ESP_ERROR_CHECK(pcnt_new_unit(&unit_cfg, &unit));
    pcnt_glitch_filter_config_t filter = {.max_glitch_ns = 1000};
    ESP_ERROR_CHECK(pcnt_unit_set_glitch_filter(unit, &filter));

    // The ESP-IDF rotary-encoder arrangement: each pin is the other's level input.
    pcnt_chan_config_t a_cfg = {.edge_gpio_num = CONFIG_DXR_DIAL_ENCODER_A_GPIO,
                                .level_gpio_num = CONFIG_DXR_DIAL_ENCODER_B_GPIO};
    pcnt_chan_config_t b_cfg = {.edge_gpio_num = CONFIG_DXR_DIAL_ENCODER_B_GPIO,
                                .level_gpio_num = CONFIG_DXR_DIAL_ENCODER_A_GPIO};
    pcnt_channel_handle_t a = NULL, b = NULL;
    ESP_ERROR_CHECK(pcnt_new_channel(unit, &a_cfg, &a));
    ESP_ERROR_CHECK(pcnt_new_channel(unit, &b_cfg, &b));
    ESP_ERROR_CHECK(pcnt_channel_set_edge_action(a, PCNT_CHANNEL_EDGE_ACTION_DECREASE, PCNT_CHANNEL_EDGE_ACTION_INCREASE));
    ESP_ERROR_CHECK(pcnt_channel_set_level_action(a, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE));
    ESP_ERROR_CHECK(pcnt_channel_set_edge_action(b, PCNT_CHANNEL_EDGE_ACTION_INCREASE, PCNT_CHANNEL_EDGE_ACTION_DECREASE));
    ESP_ERROR_CHECK(pcnt_channel_set_level_action(b, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE));

    ESP_ERROR_CHECK(pcnt_unit_enable(unit));
    ESP_ERROR_CHECK(pcnt_unit_clear_count(unit));
    ESP_ERROR_CHECK(pcnt_unit_start(unit));
    return unit;
}

static void button_init(void) {
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << CONFIG_DXR_DIAL_BUTTON_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE, // button to GND
    };
    ESP_ERROR_CHECK(gpio_config(&io));
}

static bool network_up(void) {
    esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    return sta && esp_netif_is_netif_up(sta);
}

static void dial_task(void *arg) {
    // The Muse firmware owns Wi-Fi. Wait until it is on the network before opening the socket.
    while (!network_up()) vTaskDelay(pdMS_TO_TICKS(500));

    esp_websocket_client_config_t cfg = {
        .uri = CONFIG_DXR_DIAL_BRIDGE_URL,
        .reconnect_timeout_ms = 3000,
        .network_timeout_ms = 5000,
    };
    s_ws = esp_websocket_client_init(&cfg);
    if (!s_ws) {
        ESP_LOGE(TAG, "websocket init failed");
        vTaskDelete(NULL);
        return;
    }
    esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, on_ws_event, NULL);
    esp_websocket_client_start(s_ws);

    pcnt_unit_handle_t enc = encoder_init();
    button_init();

    float depth = 0.0f, sent_depth = 0.0f;
    int64_t last_send = 0;
    bool stereo = true;
    int stable = 1, last_raw = 1;
    int64_t changed_at = 0;
    int residue = 0;

    for (;;) {
        int count = 0;
        pcnt_unit_get_count(enc, &count);
        if (count) {
            pcnt_unit_clear_count(enc);
            residue += count;
            int detents = residue / COUNTS_PER_DETENT;
            residue -= detents * COUNTS_PER_DETENT;
            depth = fminf(1.0f, fmaxf(-1.0f, depth + detents * DEPTH_PER_DETENT));
        }
        int64_t now = esp_timer_get_time();
        if (fabsf(depth - sent_depth) > 1e-4f && now - last_send >= SEND_INTERVAL_US) {
            cJSON *args = cJSON_CreateObject();
            cJSON_AddNumberToObject(args, "value", roundf(depth * 100) / 100);
            send_command("set_depth", args);
            sent_depth = depth;
            last_send = now;
        }

        int raw = gpio_get_level(CONFIG_DXR_DIAL_BUTTON_GPIO);
        if (raw != last_raw) {
            last_raw = raw;
            changed_at = now;
        } else if (raw != stable && now - changed_at >= DEBOUNCE_MS * 1000) {
            stable = raw;
            if (stable == 0) { // pressed
                stereo = !stereo;
                cJSON *args = cJSON_CreateObject();
                cJSON_AddStringToObject(args, "mode", stereo ? "3d" : "2d");
                send_command("set_mode", args);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}

void displayxr_dial_start(void) {
    if (strlen(CONFIG_DXR_DIAL_BRIDGE_SECRET) < 16) {
        ESP_LOGE(TAG, "set DXR_DIAL_BRIDGE_SECRET in menuconfig (16+ characters); dial disabled");
        return;
    }
    if (xTaskCreate(dial_task, "dxr_dial", 6144, NULL, 3, NULL) != pdPASS) {
        ESP_LOGE(TAG, "could not start the dial task");
    }
}

#endif // CONFIG_DXR_DIAL_ENABLED
