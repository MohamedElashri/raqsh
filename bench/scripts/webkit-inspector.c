#include <dlfcn.h>

/* Enable developer extras in a dedicated diagnostic process only. */
typedef void (*SetFlag)(void *, int);

void webkit_settings_set_enable_page_cache(void *settings, int enabled) {
    SetFlag set_cache = (SetFlag)dlsym(RTLD_NEXT, "webkit_settings_set_enable_page_cache");
    SetFlag set_extras = (SetFlag)dlsym(RTLD_NEXT, "webkit_settings_set_enable_developer_extras");
    set_cache(settings, enabled);
    if (set_extras)
        set_extras(settings, 1);
}
