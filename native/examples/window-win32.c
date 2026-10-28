/* A real drawable Win32 window for the C surface consumer. */
#include <windows.h>
void *mt_example_window_create(void) {
  SetProcessDPIAware();
  HINSTANCE module=GetModuleHandleW(NULL);
  WNDCLASSW type={0};type.lpfnWndProc=DefWindowProcW;type.hInstance=module;
  type.lpszClassName=L"MuTracerCValidation";
  if(!RegisterClassW(&type) && GetLastError()!=ERROR_CLASS_ALREADY_EXISTS)return NULL;
  RECT bounds={0,0,160,120};
  if(!AdjustWindowRect(&bounds,WS_OVERLAPPEDWINDOW,FALSE))return NULL;
  HWND window=CreateWindowExW(0,type.lpszClassName,L"MuTracer C surface validation",WS_OVERLAPPEDWINDOW,
    CW_USEDEFAULT,CW_USEDEFAULT,bounds.right-bounds.left,bounds.bottom-bounds.top,NULL,NULL,module,NULL);
  if(window){ShowWindow(window,SW_SHOW);UpdateWindow(window);}
  return window;
}
void mt_example_window_pump(void) {
  MSG event;
  while(PeekMessageW(&event,NULL,0,0,PM_REMOVE)){TranslateMessage(&event);DispatchMessageW(&event);}
  Sleep(1);
}
void mt_example_window_destroy(void *window) {DestroyWindow((HWND)window);}
int mt_example_window_minimize(void *window) {ShowWindow((HWND)window,SW_MINIMIZE);return IsIconic((HWND)window)!=0;}
int mt_example_window_restore(void *window,unsigned width,unsigned height) {
  HWND handle=(HWND)window;ShowWindow(handle,SW_RESTORE);
  RECT bounds={0,0,(LONG)width,(LONG)height};
  if(!AdjustWindowRect(&bounds,WS_OVERLAPPEDWINDOW,FALSE))return 0;
  if(!SetWindowPos(handle,NULL,0,0,bounds.right-bounds.left,bounds.bottom-bounds.top,SWP_NOMOVE|SWP_NOZORDER))return 0;
  return !IsIconic(handle);
}
