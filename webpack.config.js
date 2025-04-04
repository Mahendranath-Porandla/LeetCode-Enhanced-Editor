// webpack.config.js
const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');

module.exports = {
  // 1. Mode and Devtool
  mode: 'development', // Use 'production' for final builds
  devtool: 'inline-source-map', // Source maps help debugging

  // 2. Entry Point(s)
  entry: {
    // Assumes background.js is in the project root.
    // *** CHANGE THIS if background.js is in a 'src' folder (e.g., './src/background.js') ***
    background: './background.js',
  },

  // 3. Output Configuration
  output: {
    // Output bundled files to a 'dist' directory
    path: path.resolve(__dirname, 'dist'),
    // Name output files based on entry point names
    filename: '[name].bundle.js',
    // Base path for assets loaded by the browser (relative to extension root)
    publicPath: '', // Keep empty for chrome extensions usually
    // Clean the 'dist' directory before each build
    clean: true,
  },

  // 4. Module Rules (How to handle different file types)
  module: {
    rules: [
      // Rule for CSS files (required by Monaco)
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'], // Order matters: css-loader processes, style-loader injects
      },
      // Rule for font files (Monaco uses .ttf for icons)
      {
        test: /\.ttf$/,
        type: 'asset/resource', // Copies the file to output and provides its URL
        generator: {
            // Place fonts in a specific subfolder within 'dist'
            filename: 'fonts/[name][ext]'
        }
      },
    ],
  },

  // 5. Plugins
  plugins: [
    // Monaco Editor Plugin: Handles bundling Monaco's core, workers, languages, features
    new MonacoWebpackPlugin({
      // // Specify required languages to include (reduces bundle size)
      // languages: ['javascript', 'typescript', 'css', 'html', 'json', 'cpp', 'java', 'python', 'csharp', 'go', 'ruby', 'php', 'swift', 'kotlin', 'rust', 'scala'],
      // // Specify required features (optional, defaults are usually good)
      // // features: ['!gotoSymbol'], // Example: exclude a feature
      // // Output path for worker files, relative to webpack's output.path ('dist/')
      // // Using [contenthash] helps with browser caching
      // filename: 'workers/[name].[contenthash].worker.js'
    }),

    // Copy Plugin: Copies static files/folders to the 'dist' directory
    new CopyWebpackPlugin({
      patterns: [
        // Copy and Transform manifest.json
        {
          from: 'manifest.json',
          to: '.', // Copy to 'dist/' root
          transform(content, absoluteFrom) {
            try {
              const manifest = JSON.parse(content.toString());

              // Adjust background script path to be relative to 'dist/'
              if (manifest.background?.service_worker) {
                const originalPath = manifest.background.service_worker;
                manifest.background.service_worker = originalPath.replace(/^dist\//, '');
                if (originalPath !== manifest.background.service_worker) {
                    console.log(`[Manifest Transform] Background path: ${originalPath} -> ${manifest.background.service_worker}`);
                }
              }

              // Adjust web accessible resources paths relative to 'dist/'
              if (manifest.web_accessible_resources) {
                manifest.web_accessible_resources.forEach(resourceSet => {
                  if (resourceSet.resources) {
                    resourceSet.resources = resourceSet.resources.map(resourcePath => {
                      const transformedPath = resourcePath.replace(/^dist\//, '');
                       if (resourcePath !== transformedPath) {
                           console.log(`[Manifest Transform] WAR path: ${resourcePath} -> ${transformedPath}`);
                       }
                      return transformedPath;
                    });
                  }
                });
              }

              return JSON.stringify(manifest, null, 2); // Return modified JSON string
            } catch (error) {
               console.error("Error transforming manifest.json:", error);
               return content; // Return original content on error
            }
          }
        },
        // Copy other static assets directly
        { from: 'icons', to: 'icons' },             // Copy 'icons' folder
        { from: 'content_scripts', to: 'content_scripts' }, // Copy 'content_scripts' folder
        // Add more patterns here if you have other static assets (HTML files, images, etc.)
        // { from: 'popup/popup.html', to: 'popup/popup.html' },
      ],
    }),
  ],

  // 6. Resolve Configuration (How webpack finds modules)
  resolve: {
    // Allow importing modules without specifying these extensions
    extensions: ['.js'],
    // Add aliases here if needed (e.g., for simplifying import paths)
    // alias: { Utils: path.resolve(__dirname, 'src/utils/') }
  },

  // 7. Experiments (May be needed for certain webpack features/environments)
  experiments: {
      // Recommended for Service Worker / Web Worker targets
      outputModule: true,
  },

  // 8. Target Environment (Important for extensions)
  // Target 'webworker' for service workers
  target: 'webworker',
};