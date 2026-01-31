Version 1.6.9
New Features
Ruby language support - Code structure analysis now supports Ruby files with Tree-sitter integration
OpenAI service tier variants - Choose service tier (auto, default, flex) per-model in the model picker, with a new global default tier setting
Improvements
Code structure enhancements
Line numbers now included for function/method definitions, helping AI models locate and read code more efficiently
Improved parsing accuracy for Swift, TypeScript, JavaScript, C/C++, Dart, and other languages
Better handling of complex signatures, nested types, and class/interface boundaries
Performance improvements with regex caching and optimized line handling
Model picker refinements - Cleaner UI with legacy models hidden, unified planning model handling, and improved model selection consistency
Path resolution improvements - Root folder names now work as aliases in search filters and file resolution
API fixes - Temperature parameter no longer sent to reasoning models (which don't support it)