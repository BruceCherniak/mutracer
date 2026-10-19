// ProcessInfo requires no elevated privileges. The driver waits for nominal.
import Foundation
print(ProcessInfo.processInfo.thermalState.rawValue)
