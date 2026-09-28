#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef SYS_pidfd_open
#error Linux pidfd_open is required
#endif
#ifndef SYS_pidfd_send_signal
#error Linux pidfd_send_signal is required
#endif

static volatile sig_atomic_t cancelled;
static void interrupt_handler(int signal_number) { cancelled = signal_number; }
static long long clock_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static void nap(void) {
  const struct timespec interval = {.tv_sec = 0, .tv_nsec = 10000000};
  nanosleep(&interval, NULL);
}
static int pidfd(pid_t pid) { return (int)syscall(SYS_pidfd_open, pid, 0); }
static int send_pidfd(int fd, int sig) { return (int)syscall(SYS_pidfd_send_signal, fd, sig, NULL, 0); }
static const char *signal_name(int sig) {
  switch (sig) {
    case SIGHUP: return "SIGHUP";
    case SIGINT: return "SIGINT";
    case SIGQUIT: return "SIGQUIT";
    case SIGABRT: return "SIGABRT";
    case SIGKILL: return "SIGKILL";
    case SIGSEGV: return "SIGSEGV";
    case SIGPIPE: return "SIGPIPE";
    case SIGALRM: return "SIGALRM";
    case SIGTERM: return "SIGTERM";
    default: return NULL;
  }
}

enum { MAX_TRACKED_CHILDREN = 4096 };
struct tracked_child { pid_t pid; int fd; bool term_sent; bool kill_sent; };
static struct tracked_child tracked[MAX_TRACKED_CHILDREN];
static size_t tracked_count;

/* The kernel's task children list enumerates only our direct children, including
 * adopted orphans. Each signal uses a live pidfd opened while parented to us. */
static int signal_children(int sig, int *count) {
  char path[96], contents[262144];
  snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid());
  int file = open(path, O_RDONLY | O_CLOEXEC);
  if (file < 0) return -1;
  ssize_t size = read(file, contents, sizeof(contents) - 1);
  int saved = errno;
  close(file);
  if (size < 0 || size == (ssize_t)sizeof(contents) - 1) { errno = size < 0 ? saved : EOVERFLOW; return -1; }
  contents[size] = 0;
  char *cursor = contents;
  while (*cursor) {
    char *end;
    errno = 0;
    long value = strtol(cursor, &end, 10);
    if (errno || end == cursor || value <= 0 || value > INT_MAX) { errno = EPROTO; return -1; }
    cursor = end;
    while (*cursor == ' ') cursor++;
    struct tracked_child *child = NULL;
    for (size_t i = 0; i < tracked_count; i++) {
      if (tracked[i].pid == (pid_t)value && send_pidfd(tracked[i].fd, 0) == 0) {
        child = &tracked[i]; break;
      }
    }
    if (!child) {
      if (tracked_count == MAX_TRACKED_CHILDREN) { errno = EOVERFLOW; return -1; }
      int fd = pidfd((pid_t)value);
      if (fd < 0) { if (errno == ESRCH) continue; return -1; }
      child = &tracked[tracked_count++];
      *child = (struct tracked_child){.pid = (pid_t)value, .fd = fd};
    }
    bool *sent = sig == SIGKILL ? &child->kill_sent : &child->term_sent;
    if (!*sent) {
      /* A pidfd never redirects to a reused PID. Repeated TERM would interrupt
       * descendants' own bounded cleanup, including exact-ID Docker removal. */
      if (send_pidfd(child->fd, sig) != 0 && errno != ESRCH) { saved = errno; errno = saved; return -1; }
      *sent = true;
      (*count)++;
    }
  }
  return 0;
}

static void report(const char *custody, const char *error, const char *uncertainty,
                   int root_status, int have_root, int signalled) {
  printf("{\"status\":");
  if (have_root && WIFEXITED(root_status)) printf("%d", WEXITSTATUS(root_status));
  else printf("null");
  printf(",\"signal\":");
  if (have_root && WIFSIGNALED(root_status)) {
    const char *name = signal_name(WTERMSIG(root_status));
    if (name) printf("\"%s\"", name);
    else printf("\"SIG%d\"", WTERMSIG(root_status));
  } else printf("null");
  if (error) printf(",\"error\":{\"code\":\"%s\"}", error);
  else printf(",\"error\":null");
  printf(",\"custody\":\"%s\",\"uncertainty\":", custody);
  if (uncertainty) printf("\"%s\"", uncertainty);
  else printf("null");
  printf(",\"signalledCount\":%d}\n", signalled);
  fflush(stdout);
}

int main(int argc, char **argv) {
  if (argc < 5) { report("uncertain", "ESUPERVISOR", "ROLLBACK_PROCESS_ARGUMENTS", 0, 0, 0); return 0; }
  char *end;
  errno = 0;
  long timeout = strtol(argv[1], &end, 10);
  if (errno || *end || timeout < 1 || timeout > 3600000) {
    report("uncertain", "ESUPERVISOR", "ROLLBACK_PROCESS_TIMEOUT_INVALID", 0, 0, 0); return 0;
  }
  errno = 0;
  long drain_ms = strtol(argv[2], &end, 10);
  if (errno || *end || drain_ms < 5000 || drain_ms > 70000) {
    report("uncertain", "ESUPERVISOR", "ROLLBACK_PROCESS_DRAIN_INVALID", 0, 0, 0); return 0;
  }
  errno = 0;
  long term_ms = strtol(argv[3], &end, 10);
  if (errno || *end || term_ms < 1000 || term_ms > drain_ms - 1000) {
    report("uncertain", "ESUPERVISOR", "ROLLBACK_PROCESS_TERM_INVALID", 0, 0, 0); return 0;
  }
  pid_t parent = getppid();
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0 || prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || getppid() != parent) {
    report("uncertain", "ESUPERVISOR", "ROLLBACK_PROCESS_SUBREAPER_UNAVAILABLE", 0, 0, 0); return 0;
  }
  int enabled = 0;
  if (prctl(PR_GET_CHILD_SUBREAPER, &enabled) != 0 || enabled != 1) {
    report("uncertain", "ESUPERVISOR", "ROLLBACK_PROCESS_SUBREAPER_UNVERIFIED", 0, 0, 0); return 0;
  }
  int self_fd = pidfd(getpid());
  if (self_fd < 0 || send_pidfd(self_fd, 0) != 0) {
    if (self_fd >= 0) close(self_fd);
    report("uncertain", "ESUPERVISOR", "ROLLBACK_PROCESS_PIDFD_UNAVAILABLE", 0, 0, 0); return 0;
  }
  close(self_fd);
  int prerequisite_children = 0;
  if (signal_children(0, &prerequisite_children) != 0 || prerequisite_children != 0) {
    report("uncertain", "ESUPERVISOR", "ROLLBACK_PROCESS_CHILD_LIST_UNAVAILABLE", 0, 0, 0); return 0;
  }
  struct sigaction action = {.sa_handler = interrupt_handler};
  sigemptyset(&action.sa_mask);
  struct sigaction child_action = {.sa_handler = SIG_DFL};
  sigemptyset(&child_action.sa_mask);
  sigset_t empty_mask;
  sigemptyset(&empty_mask);
  if (sigprocmask(SIG_SETMASK, &empty_mask, NULL) != 0
      || sigaction(SIGCHLD, &child_action, NULL) != 0
      || sigaction(SIGINT, &action, NULL) != 0
      || sigaction(SIGTERM, &action, NULL) != 0
      || sigaction(SIGHUP, &action, NULL) != 0) {
    report("uncertain", "ESUPERVISOR", "ROLLBACK_PROCESS_SIGNAL_SETUP_FAILED", 0, 0, 0); return 0;
  }
  long long started = clock_ms();
  if (started < 0) { report("uncertain", "ESUPERVISOR", "ROLLBACK_PROCESS_CLOCK_FAILED", 0, 0, 0); return 0; }
  int exec_error[2];
  if (pipe2(exec_error, O_CLOEXEC | O_NONBLOCK) != 0) {
    report("uncertain", "ESUPERVISOR", "ROLLBACK_PROCESS_PIPE_FAILED", 0, 0, 0); return 0;
  }
  pid_t root = fork();
  if (root < 0) { close(exec_error[0]); close(exec_error[1]);
    report("uncertain", "ESUPERVISOR", "ROLLBACK_PROCESS_FORK_FAILED", 0, 0, 0); return 0; }
  if (root == 0) {
    close(exec_error[0]);
    struct sigaction default_action = {.sa_handler = SIG_DFL};
    sigemptyset(&default_action.sa_mask);
    sigaction(SIGINT, &default_action, NULL);
    sigaction(SIGTERM, &default_action, NULL);
    sigaction(SIGHUP, &default_action, NULL);
    if (setsid() < 0 || dup2(3, STDOUT_FILENO) < 0 || dup2(4, STDERR_FILENO) < 0) {
      int failure = errno; if (write(exec_error[1], &failure, sizeof(failure)) != sizeof(failure)) _exit(127); _exit(127);
    }
    close(3); close(4);
    execvp(argv[4], &argv[4]);
    int failure = errno; if (write(exec_error[1], &failure, sizeof(failure)) != sizeof(failure)) _exit(127);
    _exit(127);
  }
  close(exec_error[1]);
  int root_status = 0, have_root = 0, signalled = 0;
  const char *reason = NULL, *uncertainty = NULL;
  long long drain_start = -1;
  int clock_failures = 0;
  for (;;) {
    int status;
    pid_t reaped;
    do {
      reaped = waitpid(-1, &status, WNOHANG | __WALL);
      if (reaped == root) { root_status = status; have_root = 1; }
    } while (reaped > 0);
    if (reaped < 0 && errno != ECHILD && errno != EINTR) uncertainty = "ROLLBACK_PROCESS_WAIT_FAILED";
    /* A final wait can return ECHILD after a signal or deadline passed. Latch
     * those facts before the only path that can report completed custody. */
    if (!reason && (cancelled || getppid() != parent)) reason = "ECANCELLED";
    long long now = clock_ms();
    if (now < 0) uncertainty = "ROLLBACK_PROCESS_CLOCK_FAILED";
    else if (!reason && now - started >= timeout) reason = "ETIMEDOUT";
    if (reaped < 0 && errno == ECHILD && have_root) {
      int launch_errno = 0;
      ssize_t launch_bytes = read(exec_error[0], &launch_errno, sizeof(launch_errno));
      close(exec_error[0]);
      if (launch_bytes != 0 && launch_bytes != sizeof(launch_errno)) uncertainty = "ROLLBACK_PROCESS_EXEC_REPORT_INVALID";
      const char *launch_error = launch_bytes == sizeof(launch_errno) ? strerrorname_np(launch_errno) : NULL;
      if (!reason && (cancelled || getppid() != parent)) reason = "ECANCELLED";
      long long settled = clock_ms();
      if (settled < 0) uncertainty = "ROLLBACK_PROCESS_CLOCK_FAILED";
      else if (!reason && settled - started >= timeout) reason = "ETIMEDOUT";
      report(uncertainty ? "uncertain" : reason ? "reaped" : "completed",
        reason ? reason : launch_error, uncertainty, root_status, have_root, signalled);
      return 0;
    }
    if (now < 0) {
      now = drain_start < 0 ? started + timeout : drain_start;
      if (++clock_failures > 7000) {
        report("uncertain", reason ? reason : "ESUPERVISOR", uncertainty,
          root_status, have_root, signalled);
        return 0;
      }
    }
    if (!reason && have_root) reason = "ELEAK";
    if (reason && drain_start < 0) drain_start = now;
    if (reason) {
      int signal_number = now - drain_start >= term_ms ? SIGKILL : SIGTERM;
      if (signal_children(signal_number, &signalled) != 0) uncertainty = "ROLLBACK_PROCESS_CHILD_SCAN_FAILED";
      if (now - drain_start >= drain_ms) {
        report("uncertain", reason, uncertainty ? uncertainty : "ROLLBACK_PROCESS_DRAIN_UNCONFIRMED",
          root_status, have_root, signalled);
        return 0;
      }
    }
    nap();
  }
}
