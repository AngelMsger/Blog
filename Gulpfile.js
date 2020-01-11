const { src, dest, series, parallel } = require('gulp');
const cleanCSS = require('gulp-clean-css');
const htmlMin = require('gulp-htmlmin');
const imageMin = require('gulp-imagemin');
const uglify = require('gulp-uglify');

function css() {
    return src('./public/**/*.css')
        .pipe(cleanCSS({
            compatibility: 'ie8'
        }))
        .pipe(dest('./public'));
}

function js() {
    return src(['./public/**/*.js', '!./public/**/*.min.js'])
        .pipe(uglify())
        .pipe(dest('dist'));
}

function html() {
    return src('./public/**/*.html')
        .pipe(htmlMin({
            collapseWhitespace: true,
            minifyCSS: true,
            minifyJS: true,
            minifyURLs: true,
            removeComments: true
        }))
        .pipe(dest('./public'));
}

exports.css = css;
exports.js = js;
exports.html = html;
exports.default = series(parallel(css, js), html);
