#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
static NSWindow *nativeWindow;
void *mt_example_window_create(void) {
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
  // This host pumps events itself instead of calling -run, which normally
  // completes application launch before the first window is presented.
  [NSApp finishLaunching];
  nativeWindow=[[NSWindow alloc] initWithContentRect:NSMakeRect(100,100,160,120)
    styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
  [nativeWindow setReleasedWhenClosed:NO];
  [nativeWindow setTitle:@"MuTracer C SDK consumer"];
  [nativeWindow makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  return (__bridge void *)nativeWindow.contentView;
}
void mt_example_window_pump(void) {
  @autoreleasepool {
    NSEvent *event;
    while ((event=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate distantPast]
      inMode:NSDefaultRunLoopMode dequeue:YES])) { [NSApp sendEvent:event]; }
    [NSApp updateWindows];
  }
}
void mt_example_window_destroy(void *window) {
  (void)window;
  [nativeWindow close];
  [nativeWindow release];
  nativeWindow=nil;
}
