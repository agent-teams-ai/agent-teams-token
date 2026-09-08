#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
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
  SOURCE_PARENT_FD = 3,
  SOURCE_OBJECT_FD = 4,
  DESTINATION_PARENT_FD = 5,
  EXIT_USAGE = 64,
  EXIT_EXISTS = 73,
  EXIT_RENAME_FAILED = 74,
  EXIT_POSTCONDITION = 75
};

static int same_object(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
      ((left->st_mode & S_IFMT) == (right->st_mode & S_IFMT));
}

static int valid_leaf(int directory_fd, const char *leaf) {
  long name_max;
  size_t length;

  if (leaf == NULL || leaf[0] == '\0' || strcmp(leaf, ".") == 0 ||
      strcmp(leaf, "..") == 0 || strchr(leaf, '/') != NULL) {
    return 0;
  }
  length = strlen(leaf);
  errno = 0;
  name_max = fpathconf(directory_fd, _PC_NAME_MAX);
  if (name_max < 0) {
    if (errno != 0) {
      return 0;
    }
    name_max = NAME_MAX;
  }
  return length <= (size_t)name_max;
}

static int exclusive_rename(const char *source_leaf, const char *target_leaf) {
#if defined(__linux__)
  return (int)syscall(SYS_renameat2, SOURCE_PARENT_FD, source_leaf,
      DESTINATION_PARENT_FD, target_leaf, RENAME_NOREPLACE);
#elif defined(__APPLE__)
  return renameatx_np(SOURCE_PARENT_FD, source_leaf,
      DESTINATION_PARENT_FD, target_leaf, RENAME_EXCL);
#endif
}

int main(int argc, char **argv) {
  struct stat source_parent;
  struct stat source_object;
  struct stat source_path;
  struct stat destination_parent;
  struct stat destination_path;

  if (argc != 4 || strcmp(argv[1], "v1") != 0 ||
      !valid_leaf(SOURCE_PARENT_FD, argv[2]) ||
      !valid_leaf(DESTINATION_PARENT_FD, argv[3])) {
    fputs("usage: no-replace v1 SOURCE_LEAF DESTINATION_LEAF\n", stderr);
    return EXIT_USAGE;
  }
  if (fstat(SOURCE_PARENT_FD, &source_parent) != 0 ||
      fstat(SOURCE_OBJECT_FD, &source_object) != 0 ||
      fstat(DESTINATION_PARENT_FD, &destination_parent) != 0 ||
      !S_ISDIR(source_parent.st_mode) || !S_ISDIR(destination_parent.st_mode) ||
      (S_ISREG(source_object.st_mode) && source_object.st_nlink != 1)) {
    fputs("invalid inherited descriptors\n", stderr);
    return EXIT_USAGE;
  }
  if (fstatat(SOURCE_PARENT_FD, argv[2], &source_path, AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_object(&source_object, &source_path)) {
    fputs("source leaf does not name the held object\n", stderr);
    return EXIT_USAGE;
  }
  if (exclusive_rename(argv[2], argv[3]) != 0) {
    if (errno == EEXIST) {
      return EXIT_EXISTS;
    }
    fprintf(stderr, "exclusive rename failed: %s\n", strerror(errno));
    return EXIT_RENAME_FAILED;
  }
  errno = 0;
  if (fstatat(DESTINATION_PARENT_FD, argv[3], &destination_path,
          AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_object(&source_object, &destination_path) ||
      fstatat(SOURCE_PARENT_FD, argv[2], &source_path, AT_SYMLINK_NOFOLLOW) == 0 ||
      errno != ENOENT) {
    fputs("rename postcondition uncertain\n", stderr);
    return EXIT_POSTCONDITION;
  }
  return 0;
}
