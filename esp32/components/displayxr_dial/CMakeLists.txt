idf_component_register(
    SRCS "displayxr_dial.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_driver_pcnt esp_driver_gpio esp_netif esp_timer
)
