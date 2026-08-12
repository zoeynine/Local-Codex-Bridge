#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int remove_last_component(char *path) {
  char *separator = strrchr(path, '/');
  if (separator == NULL || separator == path) {
    return -1;
  }
  *separator = '\0';
  return 0;
}

int main(void) {
  char executable_path[PATH_MAX];
  uint32_t executable_path_size = sizeof(executable_path);
  if (_NSGetExecutablePath(executable_path, &executable_path_size) != 0) {
    return 126;
  }

  char resolved_path[PATH_MAX];
  if (realpath(executable_path, resolved_path) == NULL) {
    return 126;
  }

  /* executable -> MacOS -> Contents -> app bundle -> repository root */
  for (int index = 0; index < 4; index += 1) {
    if (remove_last_component(resolved_path) != 0) {
      return 126;
    }
  }

  char launcher_path[PATH_MAX];
  int written = snprintf(
      launcher_path,
      sizeof(launcher_path),
      "%s/bin/start-production-tunnel",
      resolved_path);
  if (written < 0 || (size_t)written >= sizeof(launcher_path)) {
    return 126;
  }
  if (access(launcher_path, R_OK) != 0) {
    return 126;
  }

  pid_t child = fork();
  if (child < 0) {
    return 125;
  }
  if (child > 0) {
    /* LaunchServices owns only this short-lived app process. */
    return 0;
  }

  if (setsid() < 0) {
    _exit(126);
  }
  pid_t grandchild = fork();
  if (grandchild < 0) {
    _exit(126);
  }
  if (grandchild > 0) {
    _exit(0);
  }

  char *const arguments[] = {
      "/bin/sh",
      launcher_path,
      NULL,
  };
  execv(arguments[0], arguments);
  _exit(127);
}
