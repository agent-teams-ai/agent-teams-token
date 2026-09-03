#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#if defined(__linux__)
#include <sys/syscall.h>
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif
#elif defined(__APPLE__)
#include <sys/attr.h>
#else
#error "no-replace helper supports only Linux and macOS"
#endif

enum {
  EXIT_USAGE = 64,
  EXIT_EXISTS = 73,
  EXIT_RENAME_FAILED = 74
};

static int exclusive_rename(const char *source, const char *target) {
#if defined(__linux__)
  return (int)syscall(
      SYS_renameat2, AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE);
#elif defined(__APPLE__)
  return renameatx_np(AT_FDCWD, source, AT_FDCWD, target, RENAME_EXCL);
#endif
}

int main(int argc, char **argv) {
  if (argc != 3 || argv[1][0] != '/' || argv[2][0] != '/') {
    fputs("usage: no-replace ABSOLUTE_SOURCE ABSOLUTE_TARGET\n", stderr);
    return EXIT_USAGE;
  }
  if (exclusive_rename(argv[1], argv[2]) == 0) {
    return 0;
  }
  if (errno == EEXIST) {
    return EXIT_EXISTS;
  }
  fprintf(stderr, "exclusive rename failed: %s\n", strerror(errno));
  return EXIT_RENAME_FAILED;
}
