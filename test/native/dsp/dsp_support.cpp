// The pass/fail counters, defined once so every check translation unit reports into the same total.
#include "dsp_support.h"

#include <cstdio>

int g_checks = 0;
int g_failed = 0;

void ok(const std::string& m) { g_checks++; std::printf("  \u2713 %s\n", m.c_str()); }
void bad(const std::string& m) {
  g_checks++; g_failed++; std::printf("  \u2717 %s\n", m.c_str());
}
void check(bool cond, const std::string& m) { cond ? ok(m) : bad(m); }
